
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

// ... keep existing code (fetchQuoteData and generateQuoteHtml functions)

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
    
    // Launch puppeteer
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: 'new'
    });
    
    // Create new page
    const page = await browser.newPage();
    
    // Set content and wait until network is idle
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
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
      displayHeaderFooter: false
    };
    
    // Generate PDF
    console.log('Generating PDF...');
    const pdfBuffer = await page.pdf(pdfOptions);
    
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
    // Cleanup
    if (browser) {
      try {
        await browser.close();
        console.log('Browser closed');
      } catch (err) {
        console.error('Error closing browser:', err);
      }
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

// Add a test endpoint to verify CORS handling
app.get('/test-cors', (req, res) => {
  console.log('CORS test endpoint called from origin:', req.headers.origin);
  res.json({ message: 'CORS test successful', time: new Date().toISOString() });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// New endpoint to test and debug CORS headers
app.get('/debug-cors', (req, res) => {
  console.log('Debug CORS endpoint called');
  console.log('Request headers:', req.headers);
  
  res.json({
    message: 'CORS debug information',
    headers: {
      origin: req.headers.origin,
      host: req.headers.host,
      referer: req.headers.referer
    },
    corsHeaders: {
      'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin'),
      'Access-Control-Allow-Methods': res.getHeader('Access-Control-Allow-Methods'),
      'Access-Control-Allow-Headers': res.getHeader('Access-Control-Allow-Headers')
    }
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Quote PDF service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS configuration: ${process.env.CORS_ORIGIN || '*'}`);
});
