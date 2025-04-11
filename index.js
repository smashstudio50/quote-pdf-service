
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Initialize Express app
const app = express();

// Set trust proxy to handle rate limiting behind reverse proxies
app.set('trust proxy', true);

// Validate required environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing required environment variables:');
  if (!supabaseUrl) console.error('- SUPABASE_URL is not defined');
  if (!supabaseKey) console.error('- SUPABASE_SERVICE_KEY is not defined');
  console.error('Please set these environment variables in your Railway dashboard');
  process.exit(1); // Exit with error code
}

console.log('Initializing Supabase client with URL:', supabaseUrl);

// Create Supabase client with service role key for storage write access
const supabase = createClient(supabaseUrl, supabaseKey);

// Parse allowed origins from environment variable or use default list
const allowedOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',') 
  : [
      'https://aclima.aismartcrew.com',
      'https://e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovableproject.com',
      'https://id-preview--e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovable.app',
      'https://localhost:3000'
    ];

console.log('Server starting with CORS configuration:');
console.log('Allowed origins:', allowedOrigins);

// Configure CORS options with detailed logging
const corsOptions = {
  origin: function (origin, callback) {
    console.log('Request origin:', origin);
    
    // Allow requests with no origin (like mobile apps, curl, etc)
    if (!origin) {
      console.log('Allowing request with no origin');
      callback(null, true);
      return;
    }
    
    // Check if the origin is in our allowed list
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      console.log('Origin explicitly allowed by CORS policy:', origin);
      callback(null, true);
      return;
    }
    
    // Check if the origin contains any of our allowed origins as substrings
    // This helps with development/preview environments with dynamic subdomains
    const isRelatedOrigin = allowedOrigins.some(allowed => 
      origin.includes(allowed.replace('https://', '')) || 
      allowed.includes(origin.replace('https://', ''))
    );
    
    if (isRelatedOrigin) {
      console.log('Related origin allowed by CORS policy:', origin);
      callback(null, true);
      return;
    }
    
    console.log('Origin rejected by CORS policy:', origin);
    callback(new Error('Not allowed by CORS policy'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info', 'ApiKey', 'Origin', 'Accept'],
  credentials: true,
  maxAge: 86400, // 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// IMPORTANT: Apply CORS middleware BEFORE other middleware
app.use(cors(corsOptions));

// Explicit handling of OPTIONS requests to ensure CORS preflight works correctly
app.options('*', cors(corsOptions));

// Add headers middleware to ensure CORS headers are always set
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // When no origin is provided, use wildcard (safer option would be to restrict this)
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, ApiKey, Origin, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Log headers being set for debugging
  console.log('Setting CORS headers for request from origin:', origin);
  
  next();
});

// Other middleware - added AFTER CORS middleware
app.use(helmet({
  // Disable content security policy for PDF generation
  contentSecurityPolicy: false,
  // Allow iframe for PDF preview
  frameguard: false
}));
app.use(express.json({ limit: '50mb' })); // Increased limit for larger images
app.use(morgan('combined'));

// Apply rate limiting with a higher limit to accommodate PDF generation
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
  skipFailedRequests: true,
  keyGenerator: (req) => {
    // Log IP addresses for debugging
    console.log('Client IP:', req.ip);
    console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
    return req.ip; 
  }
});

// Apply rate limiting selectively
app.use('/generate-quote-pdf', limiter);

// Configure timeout values
const PDF_GENERATION_TIMEOUT = parseInt(process.env.PDF_GENERATION_TIMEOUT || '120000', 10); // 2 minutes default
const IMAGE_PROCESSING_TIMEOUT = parseInt(process.env.IMAGE_PROCESSING_TIMEOUT || '60000', 10); // 1 minute default
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '180000', 10); // 3 minutes default

// Auth middleware to verify JWT token
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const token = authHeader.split(' ')[1];
    // This checks if the token is valid
    const { data, error } = await supabase.auth.getUser(token);
    
    if (error || !data.user) {
      console.error('Token verification error:', error);
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }

    // Store user info for later use
    req.user = data.user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal server error during authentication' });
  }
};

// Health endpoint for monitoring
app.get('/health', (req, res) => {
  // Return basic service health information
  const healthInfo = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'quote-pdf-service',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    supabaseConnection: !!supabase,
    timeoutSettings: {
      pdfGenerationTimeout: PDF_GENERATION_TIMEOUT,
      imageProcessingTimeout: IMAGE_PROCESSING_TIMEOUT,
      requestTimeout: REQUEST_TIMEOUT
    }
  };
  
  res.status(200).json(healthInfo);
});

// Simple ping endpoint that doesn't require CORS
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Test-cors endpoint
app.get('/test-cors', (req, res) => {
  // Return information about the request to help with debugging
  res.status(200).json({
    success: true,
    message: 'CORS test successful',
    origin: req.headers.origin
  });
});

// Function to fetch quote data from Supabase
const fetchQuoteData = async (quoteId) => {
  try {
    console.log(`Fetching quote data for ID: ${quoteId}`);
    
    // Fetch the quote
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .select('*')
      .eq('id', quoteId)
      .single();
    
    if (quoteError || !quote) {
      console.error('Error fetching quote:', quoteError);
      throw new Error(`Failed to fetch quote: ${quoteError?.message || 'Not found'}`);
    }
    
    // Fetch the line items
    const { data: lineItems, error: lineItemsError } = await supabase
      .from('quote_line_items')
      .select('*')
      .eq('quote_id', quoteId)
      .order('position');
    
    if (lineItemsError) {
      console.error('Error fetching line items:', lineItemsError);
      throw new Error(`Failed to fetch line items: ${lineItemsError.message}`);
    }
    
    // Fetch company profile
    const { data: companyProfile, error: profileError } = await supabase
      .from('company_profile')
      .select(`
        *,
        logo_url,
        default_quote_terms,
        quote_header_text,
        quote_footer_text,
        quote_title_page_heading,
        quote_title_page_subheading,
        quote_accent_color,
        quote_title_page_background_url
      `)
      .limit(1)
      .single();
    
    if (profileError) {
      console.error('Error fetching company profile:', profileError);
      // Not critical, can continue without it
    }
    
    // Fetch rooms if needed
    const { data: quoteRooms, error: roomsError } = await supabase
      .from('quote_rooms')
      .select('*')
      .eq('quote_id', quoteId)
      .order('position');
    
    if (roomsError) {
      console.error('Error fetching rooms:', roomsError);
      // Not critical, can continue without rooms
    }
    
    return {
      quote,
      lineItems: lineItems || [],
      companyProfile: companyProfile || {},
      rooms: quoteRooms || []
    };
  } catch (error) {
    console.error('Error in fetchQuoteData:', error);
    throw error;
  }
};

// Generate HTML for the quote
const generateQuoteHtml = async (quoteData, options) => {
  // ... keep existing code (HTML template generator function implementation)
};

// Image optimization function to reduce image sizes when needed
const optimizeImages = async (html, shouldOptimize = false) => {
  if (!shouldOptimize) return html;
  
  console.log('Optimizing images in HTML content...');
  
  try {
    // Simple image optimization technique - replace high resolution image URLs with resized versions
    // This is a basic implementation - in production you might want to use proper image processing
    
    // For example, if using Supabase storage, you might append transformation parameters to image URLs
    // This is a placeholder implementation that can be expanded
    const optimizedHtml = html.replace(/<img\s+src="([^"]+)"/gi, (match, url) => {
      // For Supabase storage URLs, you could add transformation parameters
      if (url.includes('supabase.co') && !url.includes('?')) {
        return `<img src="${url}?width=800&quality=80"`;
      }
      return match;
    });
    
    console.log('Image optimization complete');
    return optimizedHtml;
  } catch (error) {
    console.error('Error optimizing images:', error);
    // Return original HTML if optimization fails
    return html;
  }
};

// Main endpoint for generating quote PDFs with improved timeout handling and image optimization
app.post('/generate-quote-pdf', verifyToken, async (req, res) => {
  console.log('PDF generation request received');
  console.log('Request origin:', req.headers.origin);
  console.log('Request headers:', req.headers);
  
  const startTime = Date.now();
  let browser = null;
  let tempHtmlPath = null;
  let tempPdfPath = null;
  
  // Set a timeout for the entire request
  const requestTimeoutId = setTimeout(() => {
    if (!res.headersSent) {
      console.error('Request timeout after', REQUEST_TIMEOUT, 'ms');
      res.status(504).json({ 
        error: 'PDF generation timed out', 
        message: 'The request took too long to complete. Try reducing image sizes or optimizing your PDF.' 
      });
    }
  }, REQUEST_TIMEOUT);
  
  try {
    const { quoteId, options } = req.body;
    
    if (!quoteId) {
      clearTimeout(requestTimeoutId);
      return res.status(400).json({ error: 'Missing quoteId parameter' });
    }
    
    console.log(`Processing quote PDF generation for quote ID: ${quoteId}`);
    console.log('Options:', options);
    
    // Create temp directory for files if it doesn't exist
    const tempDir = path.join(os.tmpdir(), 'quote-pdfs');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Fetch all necessary data for the quote
    const quoteData = await fetchQuoteData(quoteId);
    console.log(`Successfully fetched data for quote ${quoteId}`);
    
    // Generate HTML for the quote
    const html = await generateQuoteHtml(quoteData, options || {});
    
    if (!html) {
      throw new Error('HTML generation failed - html is undefined');
    }
    
    // Apply image optimization if requested
    const processedHtml = await optimizeImages(html, options?.optimizeImages);
    
    // Save HTML to temp file (for debugging)
    tempHtmlPath = path.join(tempDir, `quote-${quoteId}-${Date.now()}.html`);
    fs.writeFileSync(tempHtmlPath, processedHtml, 'utf8');
    console.log(`HTML saved to ${tempHtmlPath}`);
    
    // Launch browser with optimized configuration
    console.log('Launching browser with optimized configuration...');
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--js-flags=--max-old-space-size=512', // Limit JS memory usage
      ],
      headless: 'new',
      timeout: PDF_GENERATION_TIMEOUT,
    });
    
    console.log('Browser launched successfully');
    
    // Create new page with error logging
    console.log('Creating new page...');
    const page = await browser.newPage();
    
    // Configure page to optimize resource loading
    await page.setJavaScriptEnabled(true);
    await page.setCacheEnabled(true); // Enable cache for images
    await page.setRequestInterception(true);
    
    // Only block unnecessary resources but allow images
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['font', 'media', 'websocket'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });
    
    // Add page error event listeners for debugging
    page.on('error', err => {
      console.error('Page error:', err);
    });
    
    page.on('pageerror', err => {
      console.error('Page JS error:', err);
    });
    
    page.on('console', msg => {
      console.log('Page console message:', msg.text());
    });
    
    // Set timeout for image processing
    const imageTimeoutId = setTimeout(() => {
      console.warn('Image processing is taking longer than expected. Continuing with PDF generation...');
    }, IMAGE_PROCESSING_TIMEOUT);
    
    // Set content with stepped approach for more stable rendering
    console.log('Setting page content...');
    try {
      await page.setContent(processedHtml, { 
        waitUntil: ['domcontentloaded', 'networkidle0'],
        timeout: IMAGE_PROCESSING_TIMEOUT
      });
      
      clearTimeout(imageTimeoutId);
      
      // Wait for all images to load with improved error handling
      await page.evaluate(() => {
        return new Promise((resolve) => {
          const imgs = document.querySelectorAll('img');
          if (imgs.length === 0) {
            return resolve(true);
          }
          
          let loadedImages = 0;
          const totalImages = imgs.length;
          
          console.log(`Waiting for ${totalImages} images to load...`);
          
          const imageLoaded = () => {
            loadedImages++;
            if (loadedImages === totalImages) {
              console.log('All images loaded successfully');
              resolve(true);
            }
          };
          
          // Set a maximum wait time per image
          const imageTimeout = 10000; // 10 seconds per image
          
          imgs.forEach(img => {
            // Handle already loaded images
            if (img.complete) {
              imageLoaded();
              return;
            }
            
            // Handle load and error events
            img.addEventListener('load', imageLoaded);
            img.addEventListener('error', () => {
              console.warn(`Failed to load image: ${img.src}`);
              imageLoaded(); // Count errors as loaded to avoid hanging
            });
            
            // Set timeout for this specific image
            setTimeout(() => {
              if (!img.complete) {
                console.warn(`Image load timeout: ${img.src}`);
                imageLoaded(); // Force continue after timeout
              }
            }, imageTimeout);
          });
        });
      }).catch(err => {
        console.warn('Warning during image loading, continuing anyway:', err);
        // Continue anyway even if image loading has issues
      });
      
      // Wait for network to be idle and all content to load
      await page.waitForFunction(() => document.readyState === 'complete', {
        timeout: 30000
      }).catch(err => {
        console.warn('Warning during page load completion, continuing anyway:', err);
        // Continue anyway even if not all content is fully loaded
      });
      
      console.log('Page content set successfully');
    } catch (contentError) {
      console.error('Error setting page content:', contentError);
      // Continue anyway, we might still be able to generate a PDF even with content errors
      console.log('Attempting to continue PDF generation despite content errors...');
    }
    
    // Set PDF options with better margins for A4/Letter
    const pdfOptions = {
      format: options?.pageSize || 'A4',
      printBackground: true,
      margin: {
        top: '10mm',
        right: '10mm',
        bottom: '10mm',
        left: '10mm'
      },
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      timeout: PDF_GENERATION_TIMEOUT,
      omitBackground: false,
      scale: 1
    };
    
    // Generate PDF with improved error handling
    console.log('Generating PDF with options:', pdfOptions);
    let pdfBuffer;
    try {
      // Force a small delay to ensure all content is rendered
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
      
      // Generate the PDF with explicit error handling and timeout
      pdfBuffer = await Promise.race([
        page.pdf(pdfOptions),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`PDF generation timeout after ${PDF_GENERATION_TIMEOUT/1000}s`)), 
            PDF_GENERATION_TIMEOUT)
        )
      ]);
      
      if (!pdfBuffer || !pdfBuffer.length) {
        throw new Error('PDF generation produced empty buffer');
      }
      
      console.log('PDF generated successfully:', pdfBuffer.length, 'bytes');
    } catch (pdfError) {
      console.error('Error generating PDF:', pdfError);
      throw new Error(`Failed to generate PDF: ${pdfError.message}`);
    }
    
    // Save PDF to temp file
    const fileName = `quote-${quoteData.quote.reference.replace(/\s+/g, '-')}-${Date.now()}.pdf`;
    tempPdfPath = path.join(tempDir, fileName);
    
    try {
      if (!pdfBuffer) {
        throw new Error('Cannot write null or undefined PDF buffer');
      }
      fs.writeFileSync(tempPdfPath, pdfBuffer);
      console.log(`PDF saved to ${tempPdfPath}`);
    } catch (writeError) {
      console.error('Error writing PDF file:', writeError);
      throw new Error(`Failed to write PDF file: ${writeError.message}`);
    }
    
    // Upload PDF to Supabase Storage
    console.log('Uploading PDF to Supabase Storage...');
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('quote_pdfs')
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });
    
    if (uploadError) {
      console.error('Error uploading PDF to storage:', uploadError);
      throw new Error(`Failed to upload PDF: ${uploadError.message}`);
    }
    
    // Generate a public URL
    const { data: urlData } = await supabase.storage
      .from('quote_pdfs')
      .getPublicUrl(fileName);
    
    const publicUrl = urlData.publicUrl;
    
    // Record processing time
    const processingTime = Date.now() - startTime;
    console.log(`PDF generated and uploaded successfully in ${processingTime}ms`);
    
    // Clear the request timeout since we're responding successfully
    clearTimeout(requestTimeoutId);
    
    // Return success response with URL
    res.json({
      success: true,
      documentUrl: publicUrl,
      fileName: fileName,
      processingTime: processingTime
    });
  } catch (error) {
    console.error('Error in PDF generation:', error);
    
    // Clear the request timeout since we're responding with an error
    clearTimeout(requestTimeoutId);
    
    // Return detailed error with additional information
    res.status(500).json({
      error: 'Failed to generate PDF',
      message: error.message,
      details: 'The server encountered an error while generating the PDF. This may be due to a timeout, large images, or formatting issues.',
      suggestions: [
        'Try reducing the size of images in your quote',
        'Check if there are too many items or complex content',
        'Try again with image optimization enabled',
        'Break large quotes into smaller ones'
      ],
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    });
  } finally {
    // Cleanup resources
    if (browser) {
      try {
        console.log('Closing browser...');
        await browser.close();
        console.log('Browser closed successfully');
      } catch (err) {
        console.error('Error closing browser:', err);
      }
    }
    
    // Log memory usage to help debug resource constraints
    try {
      const memoryUsage = process.memoryUsage();
      console.log('Memory usage after PDF generation:', {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`, 
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
        external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`
      });
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        console.log('Manual garbage collection triggered');
      }
    } catch (err) {
      console.error('Error logging memory usage:', err);
    }
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Timeout settings: PDF=${PDF_GENERATION_TIMEOUT}ms, Images=${IMAGE_PROCESSING_TIMEOUT}ms, Request=${REQUEST_TIMEOUT}ms`);
  
  // Log memory usage at startup
  const memoryUsage = process.memoryUsage();
  const usedMemoryMB = Math.round(memoryUsage.rss / 1024 / 1024);
  console.log(`Memory usage at startup: ${usedMemoryMB}MB`);
});
