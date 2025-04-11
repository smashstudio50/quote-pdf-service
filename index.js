
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Quote PDF service running on port ${PORT}`);
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS configuration: ${process.env.CORS_ORIGIN || '*'}`);
});

// Set trust proxy to handle rate limiting behind reverse proxies
app.set('trust proxy', true);

// Create Supabase client with service role key for storage write access
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Parse allowed origins from environment variable
const allowedOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',') 
  : ['*'];

console.log('Server starting with CORS configuration:');
console.log('Allowed origins:', allowedOrigins);

// IMPROVED: More permissive CORS configuration for debugging
const corsOptions = {
  origin: function (origin, callback) {
    console.log('Request origin:', origin);
    
    // Allow requests with no origin (like mobile apps, curl, etc)
    if (!origin) {
      console.log('Allowing request with no origin');
      callback(null, true);
      return;
    }
    
    // Check if the origin is in our allowed list or if we're allowing all origins
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      console.log('Origin allowed by CORS policy:', origin);
      callback(null, true);
    } else {
      // Check if the origin contains any of our allowed origins as substrings
      // This helps with development/preview environments with dynamic subdomains
      const isRelatedOrigin = allowedOrigins.some(allowed => 
        origin.includes(allowed) || allowed.includes(origin)
      );
      
      if (isRelatedOrigin) {
        console.log('Related origin allowed by CORS policy:', origin);
        callback(null, true);
        return;
      }
      
      console.log('Origin rejected by CORS policy:', origin);
      callback(new Error('Not allowed by CORS policy'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info', 'ApiKey'],
  credentials: true,
  maxAge: 86400 // 24 hours
};

// Apply CORS middleware with options
app.use(cors(corsOptions));

// Add headers middleware to ensure CORS headers are always set
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, ApiKey');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Log headers being set
  console.log('Setting CORS headers for request from origin:', origin);
  
  next();
});

// Add a middleware to ensure OPTIONS requests are handled properly
app.options('*', (req, res) => {
  // Get the origin from the request
  const origin = req.headers.origin;
  
  console.log('OPTIONS request received from origin:', origin);
  
  // Allow all OPTIONS requests for debugging
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, ApiKey');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Respond with 200 OK for OPTIONS requests
  return res.sendStatus(200);
});

// Middleware
app.use(helmet({
  // Disable content security policy for PDF generation
  contentSecurityPolicy: false,
  // Allow iframe for PDF preview
  frameguard: false
}));
app.use(express.json({ limit: '20mb' }));
app.use(morgan('combined'));

// Apply rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
  // Add a custom handler to bypass rate limiting on specific endpoints for debugging
  skipFailedRequests: true,
  // Safely handle rate limit bypass for trusted proxies
  keyGenerator: (req) => {
    // Add additional logging for IP addresses to help debug
    console.log('Client IP:', req.ip);
    console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
    return req.ip; 
  }
});
app.use('/generate-quote-pdf', limiter);

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

// Function to fetch quote data from Supabase - DEFINE THE FUNCTION BEFORE IT'S USED
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

// Function to generate HTML for the quote
const generateQuoteHtml = async (quoteData, options) => {
  // ... keep existing code (HTML template generator function)
};

// Main endpoint for generating quote PDFs
app.post('/generate-quote-pdf', verifyToken, async (req, res) => {
  console.log('PDF generation request received');
  console.log('Request origin:', req.headers.origin);
  console.log('Request headers:', req.headers);
  
  const startTime = Date.now();
  let browser = null;
  let tempHtmlPath = null;
  let tempPdfPath = null;
  
  try {
    const { quoteId, options } = req.body;
    
    if (!quoteId) {
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
    const html = await generateQuoteHtml(quoteData, options);
    
    // Save HTML to temp file (for debugging)
    tempHtmlPath = path.join(tempDir, `quote-${quoteId}-${Date.now()}.html`);
    fs.writeFileSync(tempHtmlPath, html);
    console.log(`HTML saved to ${tempHtmlPath}`);
    
    // IMPROVED: Enhanced Puppeteer configuration for containerized environments
    console.log('Launching browser with enhanced configuration...');
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // Overcome limited resource problems
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
      headless: 'new',
      timeout: 30000, // 30 second timeout
    });
    
    console.log('Browser launched successfully');
    
    // Create new page with more verbose error logging
    console.log('Creating new page...');
    const page = await browser.newPage();
    console.log('Page created');
    
    // Add page error event listeners for better debugging
    page.on('error', err => {
      console.error('Page error:', err);
    });
    
    page.on('pageerror', err => {
      console.error('Page JS error:', err);
    });
    
    // Set content with improved error handling
    console.log('Setting page content...');
    try {
      await page.setContent(html, { 
        waitUntil: ['load', 'networkidle0'],
        timeout: 30000 // 30 second timeout
      });
      console.log('Page content set successfully');
    } catch (contentError) {
      console.error('Error setting page content:', contentError);
      throw new Error(`Failed to set page content: ${contentError.message}`);
    }
    
    // Set PDF options
    const pdfOptions = {
      format: options?.pageSize || 'A4',
      printBackground: true,
      margin: {
        top: process.env.PDF_MARGIN_TOP || '20mm',
        right: process.env.PDF_MARGIN_RIGHT || '20mm',
        bottom: process.env.PDF_MARGIN_BOTTOM || '20mm',
        left: process.env.PDF_MARGIN_LEFT || '20mm'
      },
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      timeout: 60000 // 60 second timeout for PDF generation
    };
    
    // Generate PDF with improved error handling
    console.log('Generating PDF with options:', pdfOptions);
    let pdfBuffer;
    try {
      pdfBuffer = await page.pdf(pdfOptions);
      console.log('PDF generated successfully:', pdfBuffer.length, 'bytes');
    } catch (pdfError) {
      console.error('Error generating PDF:', pdfError);
      throw new Error(`Failed to generate PDF: ${pdfError.message}`);
    }
    
    // Save PDF to temp file
    const fileName = `quote-${quoteData.quote.reference.replace(/\s+/g, '-')}-${Date.now()}.pdf`;
    tempPdfPath = path.join(tempDir, fileName);
    fs.writeFileSync(tempPdfPath, pdfBuffer);
    console.log(`PDF saved to ${tempPdfPath}`);
    
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
    
    // Generate a public URL (or signed URL if not public)
    const { data: urlData } = await supabase.storage
      .from('quote_pdfs')
      .getPublicUrl(fileName);
    
    const publicUrl = urlData.publicUrl;
    
    // Record processing time
    const processingTime = Date.now() - startTime;
    console.log(`PDF generated and uploaded successfully in ${processingTime}ms`);
    
    // Return success response with URL
    res.json({
      success: true,
      documentUrl: publicUrl,
      fileName: fileName,
      processingTime: processingTime
    });
  } catch (error) {
    console.error('Error in PDF generation:', error);
    res.status(500).json({
      error: 'Failed to generate PDF',
      message: error.message
    });
  } finally {
    // Cleanup with improved error handling
    if (browser) {
      try {
        console.log('Closing browser...');
        await browser.close();
        console.log('Browser closed successfully');
      } catch (err) {
        console.error('Error closing browser:', err);
      }
    } else {
      console.log('No browser instance to close');
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
    } catch (err) {
      console.error('Error logging memory usage:', err);
    }
    
    // Cleanup temp files (optional - can keep for debugging)
    // if (tempHtmlPath && fs.existsSync(tempHtmlPath)) {
    //   fs.unlinkSync(tempHtmlPath);
    // }
    // if (tempPdfPath && fs.existsSync(tempPdfPath)) {
    //   fs.unlinkSync(tempPdfPath);
    // }
  }
});

// ... keep existing code (test endpoints and server startup)
