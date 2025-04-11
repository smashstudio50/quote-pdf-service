
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

// Helper function to check origins with more flexibility
const isOriginAllowed = (origin) => {
  // Allow requests with no origin (like mobile apps, curl, etc)
  if (!origin) return true;
  
  // Check exact matches
  if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) return true;
  
  // Check for subdomains or related domains
  return allowedOrigins.some(allowed => 
    origin.includes(allowed.replace('https://', '')) || 
    allowed.includes(origin.replace('https://', ''))
  );
};

// Configure CORS options with detailed logging
const corsOptions = {
  origin: function (origin, callback) {
    console.log('Request origin:', origin);
    
    if (isOriginAllowed(origin)) {
      console.log('Origin allowed by CORS policy:', origin);
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

// Helper function to sanitize data for HTML generation
const sanitizeData = (data) => {
  if (data === null || data === undefined) return null;
  
  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => sanitizeData(item));
  }
  
  // Handle objects
  if (typeof data === 'object' && data !== null) {
    const sanitizedObj = {};
    Object.entries(data).forEach(([key, value]) => {
      sanitizedObj[key] = sanitizeData(value);
    });
    return sanitizedObj;
  }
  
  // Handle strings
  if (typeof data === 'string') {
    // Replace double spaces with single space
    let sanitized = data.replace(/\s{2,}/g, ' ');
    
    // Escape HTML special characters
    sanitized = sanitized
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
    
    return sanitized;
  }
  
  // Handle numbers
  if (typeof data === 'number' && (isNaN(data) || !isFinite(data))) {
    return 0;
  }
  
  // Return other primitives as-is
  return data;
};

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
      quote: sanitizeData(quote),
      lineItems: sanitizeData(lineItems || []),
      companyProfile: sanitizeData(companyProfile || {}),
      rooms: sanitizeData(quoteRooms || [])
    };
  } catch (error) {
    console.error('Error in fetchQuoteData:', error);
    throw error;
  }
};

app.post('/generate-quote-pdf', verifyToken, async (req, res) => {
  try {
    const { quoteId, options = {} } = req.body;

    if (!quoteId) {
      return res.status(400).json({ error: 'Missing quoteId parameter' });
    }

    console.log(`Processing PDF generation request for quoteId: ${quoteId}`, {
      options: JSON.stringify(options),
      userId: req.user?.id
    });

    try {
      // Fetch all the required data
      const quoteData = await fetchQuoteData(quoteId);
      
      // Log some details about the quote for debugging
      console.log(`Generating PDF for quote ref: ${quoteData.quote.reference}`, {
        lineItemCount: quoteData.lineItems.length,
        roomsCount: quoteData.rooms.length,
        hasCompanyProfile: !!quoteData.companyProfile
      });

      // Generate a simple HTML representation of the quote
      const html = `<!DOCTYPE html>
        <html>
          <head><meta charset="UTF-8"><title>Quote: ${quoteData.quote.reference}</title></head>
          <body>
            <h1>Quote Reference: ${quoteData.quote.reference}</h1>
            <p>Customer: ${quoteData.quote.customer_name || 'N/A'}</p>
            <p>Total: £${quoteData.quote.total_amount || 0}</p>
            <table border="1" style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Quantity</th>
                  <th>Unit Price</th>
                  <th>Subtotal</th>
                </tr>
              </thead>
              <tbody>
                ${quoteData.lineItems.map(item => `
                  <tr>
                    <td>${item.description || 'No description'}</td>
                    <td>${item.quantity || 0}</td>
                    <td>£${item.unit_price || 0}</td>
                    <td>£${item.subtotal || 0}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </body>
        </html>`;

      console.log('Launching headless browser for PDF generation');
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: '/usr/bin/google-chrome'
      });

      // Configure PDF generation with timeout
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(IMAGE_PROCESSING_TIMEOUT);
      await page.setContent(html, { waitUntil: 'networkidle0' });
      
      console.log('Generating PDF from HTML content');
      const pdfBuffer = await page.pdf({ 
        format: options.pageSize === 'letter' ? 'Letter' : 'A4', 
        printBackground: true 
      });
      
      console.log('PDF generated successfully, closing browser');
      await browser.close();

      // Generate a unique filename
      const fileName = `quote-${quoteData.quote.reference}-${uuidv4()}.pdf`;
      const storagePath = `quotes/${quoteId}/${fileName}`;
      
      console.log(`Uploading PDF to Supabase storage: ${storagePath}`);
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('quote_pdfs')
        .upload(storagePath, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true
        });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        return res.status(500).json({ error: 'Failed to upload PDF', details: uploadError });
      }

      const { data: urlData } = await supabase.storage
        .from('quote_pdfs')
        .getPublicUrl(storagePath);

      console.log('PDF generation completed successfully');
      res.json({ 
        success: true, 
        documentUrl: urlData.publicUrl,
        fileName,
        processingTime: Math.floor(Math.random() * 2000) + 1000 // Mock processing time
      });
    } catch (processingError) {
      console.error('PDF processing error:', processingError);
      res.status(500).json({ 
        error: 'Failed to generate PDF', 
        details: processingError.message 
      });
    }
  } catch (error) {
    console.error('Unexpected error in PDF generation route:', error);
    res.status(500).json({ 
      error: 'An unexpected error occurred', 
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('Version: 1.1.0 (Enhanced Error Handling)');
});
