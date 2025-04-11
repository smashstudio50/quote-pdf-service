
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
const generateQuoteHtml = (quoteData, options) => {
  try {
    if (!quoteData || !quoteData.quote) {
      console.error('Missing quote data in generateQuoteHtml');
      throw new Error('Quote data is missing or invalid');
    }
    
    console.log('Generating HTML with quote data:', JSON.stringify({
      quote_id: quoteData.quote.id,
      reference: quoteData.quote.reference,
      line_items_count: quoteData.lineItems?.length || 0,
      rooms_count: quoteData.rooms?.length || 0,
      options: options
    }));
    
    const { quote, lineItems, companyProfile, rooms } = quoteData;
    
    // Basic formatting functions
    const formatCurrency = (amount) => {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP',
      }).format(amount || 0);
    };
    
    const formatDate = (dateString) => {
      try {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        });
      } catch (error) {
        console.error('Error formatting date:', error);
        return 'Date not available';
      }
    };
    
    const getAddress = () => {
      try {
        if (quote.site_address) return quote.site_address;
        
        return [
          quote.site_address_line1,
          quote.site_address_line2,
          quote.site_city,
          quote.site_postcode,
          quote.site_country
        ].filter(Boolean).join(', ') || 'Address not available';
      } catch (error) {
        console.error('Error getting address:', error);
        return 'Address not available';
      }
    };
    
    // Generate rooms section HTML
    const generateRoomsSections = () => {
      try {
        if (!rooms || rooms.length === 0) return '';
        
        const accentColor = options?.accentColor || companyProfile?.quote_accent_color || '#3b82f6';
        
        return `
          <h3 style="color: ${accentColor}; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-top: 30px;">Rooms and Equipment</h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 15px; margin-top: 15px;">
            ${rooms.map(room => `
              <div style="border: 1px solid #ddd; border-radius: 5px; padding: 15px; background-color: #fff;">
                <div style="display: flex; align-items: center; margin-bottom: 10px;">
                  <span style="font-size: 1.5em; margin-right: 10px;">${room.icon || '🏠'}</span>
                  <div>
                    <h4 style="margin: 0; font-size: 16px;">${room.name || 'Room'}</h4>
                    ${room.custom_label ? `<p style="margin: 0; color: #666; font-size: 14px;">${room.custom_label}</p>` : ''}
                  </div>
                </div>
                
                ${room.dimensions ? `
                  <div style="background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin-bottom: 15px; font-size: 14px;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                      <p style="margin: 0; color: #555;">Width: ${room.dimensions.width || 0}m</p>
                      <p style="margin: 0; color: #555;">Length: ${room.dimensions.length || 0}m</p>
                      <p style="margin: 0; color: #555;">Height: ${room.dimensions.height || 0}m</p>
                      ${room.dimensions.area ? `<p style="margin: 0; color: #555;">Area: ${room.dimensions.area}m²</p>` : ''}
                      ${room.dimensions.volume ? `<p style="margin: 0; color: #555;">Volume: ${room.dimensions.volume}m³</p>` : ''}
                    </div>
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        `;
      } catch (error) {
        console.error('Error generating rooms section:', error);
        return '<!-- Error generating rooms section -->';
      }
    };
    
    // Design settings with fallbacks
    const accentColor = options?.accentColor || companyProfile?.quote_accent_color || '#3b82f6';
    const headerText = companyProfile?.quote_header_text || '';
    const footerText = companyProfile?.quote_footer_text || 'Thank you for your business';
    const titlePageHeading = options?.titlePage?.heading || companyProfile?.quote_title_page_heading || 'Professional Quotation';
    const titlePageSubheading = options?.titlePage?.subheading || companyProfile?.quote_title_page_subheading || quote.reference || 'Quote';
    const titlePageBackgroundUrl = options?.titlePage?.backgroundUrl || companyProfile?.quote_title_page_background_url || '';
    const pageSize = options?.pageSize || 'a4';
    
    // Generate line items HTML
    const lineItemsHtml = (lineItems || []).map(item => `
      <tr>
        <td>
          <strong>${item.description || 'Item'}</strong>
          ${item.equipment_make && item.equipment_model ? 
            `<br><span style="font-size: 0.9em; color: #666;">${item.equipment_make} ${item.equipment_model}</span>` : ''}
        </td>
        <td>${item.quantity || 1}</td>
        <td>${formatCurrency(item.unit_price || 0)}</td>
        <td>${formatCurrency(item.subtotal || 0)}</td>
      </tr>
    `).join('');
    
    // Complete HTML template
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${quote.reference || 'Quote'} - Quotation</title>
  <style>
    @page {
      size: ${pageSize === 'a4' ? 'A4' : 'letter'};
    }
    
    @page :first {
      margin: 0;
    }
    
    @page :not(:first) {
      margin: 2cm;
    }
    
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      margin: 0;
      padding: 0;
      background-color: #fff;
    }
    
    .container {
      max-width: 21cm;
      margin: 0 auto;
      padding: 0;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 2px solid ${accentColor};
    }
    
    .logo {
      max-height: 80px;
      margin-bottom: 10px;
    }
    
    .custom-header {
      background-color: #f8f9fa;
      padding: 10px;
      text-align: center;
      margin-bottom: 20px;
      color: ${accentColor};
      font-style: italic;
    }
    
    .company-info {
      font-size: 14px;
    }
    
    .quote-info {
      text-align: right;
    }
    
    .quote-info h2 {
      color: ${accentColor};
      margin-bottom: 10px;
    }
    
    .customer-info {
      margin-bottom: 30px;
    }
    
    h3 {
      color: ${accentColor};
      border-bottom: 1px solid #ddd;
      padding-bottom: 5px;
      margin-top: 30px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    
    th {
      background-color: #f2f2f2;
      text-align: left;
      padding: 10px;
      border: 1px solid #ddd;
    }
    
    td {
      padding: 10px;
      border: 1px solid #ddd;
    }
    
    tr:nth-child(even) {
      background-color: #f9f9f9;
    }
    
    .amount-summary {
      margin-top: 20px;
      text-align: right;
    }
    
    .total {
      font-size: 18px;
      font-weight: bold;
      margin-top: 10px;
      color: ${accentColor};
    }
    
    .notes {
      margin-top: 40px;
      background-color: #f9f9f9;
      padding: 15px;
      border-radius: 5px;
    }
    
    .footer {
      margin-top: 60px;
      text-align: center;
      font-size: 12px;
      color: #666;
      border-top: 1px solid #ddd;
      padding-top: 20px;
    }
    
    .title-page {
      width: 100vw;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      background: ${titlePageBackgroundUrl ? `url(${titlePageBackgroundUrl}) no-repeat center center` : 'linear-gradient(135deg, #fff, #f5f5f5)'};
      background-size: cover;
      position: relative;
      margin: 0;
      padding: 0;
      page-break-after: always;
    }
    
    .title-page-content {
      position: relative;
      z-index: 2;
      padding: 40px;
      background-color: rgba(255, 255, 255, 0.85);
      border-radius: 10px;
      max-width: 500px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    
    .title-page h1 {
      font-size: 32px;
      color: ${accentColor};
      margin-bottom: 10px;
    }
    
    .title-page h2 {
      font-size: 24px;
      color: #666;
      font-weight: normal;
    }
    
    .title-page img {
      max-width: 200px;
      margin-bottom: 40px;
    }
    
    @media print {
      body {
        font-size: 12pt;
      }
      
      .container {
        width: 100%;
        max-width: none;
      }
      
      .no-print {
        display: none;
      }
      
      .page-break {
        page-break-before: always;
      }
      
      .title-page {
        width: 100vw;
        height: 100vh;
        margin: 0;
        padding: 0;
      }
    }
  </style>
</head>
<body>
  <div class="title-page">
    <div class="title-page-content">
      ${companyProfile?.logo_url ? `<img src="${companyProfile.logo_url}" alt="Company Logo">` : ''}
      <h1>${titlePageHeading}</h1>
      <h2>${titlePageSubheading}</h2>
      <p style="margin-top: 40px; color: #666;">${formatDate(quote.created_at || new Date())}</p>
      <p style="color: #666; font-weight: bold;">${quote.customer_name || 'Customer'}</p>
      <p style="color: #666;">${getAddress()}</p>
    </div>
  </div>

  <div class="container">
    ${headerText ? `<div class="custom-header">${headerText}</div>` : ''}
    
    <div class="header">
      <div>
        ${companyProfile?.logo_url ? `<img src="${companyProfile.logo_url}" alt="Company Logo" class="logo">` : ''}
        <div class="company-info">
          <div><strong>${companyProfile?.company_name || 'Your Company'}</strong></div>
          <div>${companyProfile?.address_line1 || ''}</div>
          ${companyProfile?.address_line2 ? `<div>${companyProfile.address_line2}</div>` : ''}
          <div>${companyProfile?.city || ''} ${companyProfile?.postcode || ''}</div>
          <div>${companyProfile?.phone || ''}</div>
          <div>${companyProfile?.email || ''}</div>
        </div>
      </div>
      <div class="quote-info">
        <h2>QUOTATION</h2>
        <div><strong>Reference:</strong> ${quote.reference || 'QT-' + new Date().getTime()}</div>
        <div><strong>Date:</strong> ${formatDate(quote.created_at || new Date())}</div>
        <div><strong>Valid until:</strong> ${quote.validity_period || 30} days</div>
      </div>
    </div>
    
    <div class="customer-info">
      <h3>Customer Information</h3>
      <div><strong>Name:</strong> ${quote.customer_name || 'Customer'}</div>
      <div><strong>Project Address:</strong> ${getAddress()}</div>
      ${quote.type ? `<div><strong>Project Type:</strong> ${quote.type}</div>` : ''}
      ${quote.building_type ? `<div><strong>Building Type:</strong> ${quote.building_type}</div>` : ''}
    </div>
    
    ${generateRoomsSections()}
    
    <div class="page-break"></div>
    
    <h3>Quote Items</h3>
    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th>Quantity</th>
          <th>Unit Price</th>
          <th>Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${lineItemsHtml || `<tr><td colspan="4">No items available</td></tr>`}
      </tbody>
    </table>
    
    <div class="amount-summary">
      <div><strong>Subtotal:</strong> ${formatCurrency(quote.subtotal || 0)}</div>
      ${quote.tax_amount ? `<div><strong>VAT (${quote.tax_rate || 20}%):</strong> ${formatCurrency(quote.tax_amount)}</div>` : ''}
      ${quote.discount_amount ? `<div><strong>Discount:</strong> ${formatCurrency(quote.discount_amount)}</div>` : ''}
      <div class="total"><strong>Total:</strong> ${formatCurrency(quote.total_amount || 0)}</div>
    </div>
    
    <div class="page-break"></div>
    
    ${quote.terms || companyProfile?.default_quote_terms ? `
      <div class="notes">
        <h3>Terms and Conditions</h3>
        <div style="white-space: pre-line;">${quote.terms || companyProfile?.default_quote_terms || ''}</div>
      </div>
    ` : ''}
    
    <div class="footer">
      <p>${footerText}</p>
      <p>${companyProfile?.company_name || 'Your Company'}</p>
    </div>
  </div>
</body>
</html>
    `;
    
    console.log('HTML generation completed successfully');
    return html;
  } catch (error) {
    console.error('Error generating HTML:', error);
    throw new Error(`HTML generation failed - ${error.message}`);
  }
};

// Process images to optimize them if needed
const optimizeImages = (html, shouldOptimize) => {
  try {
    if (!shouldOptimize) return html;
    
    console.log("Optimizing images in HTML...");
    
    // Simple optimization - this approach limits image dimensions using style attributes
    // In a production solution, you might want to use actual image processing
    const optimizedHtml = html.replace(/<img([^>]*)>/g, (match, attributes) => {
      // Only add style if it doesn't already have a style attribute with max-width
      if (!attributes.includes('max-width') && !attributes.includes('style')) {
        return `<img${attributes} style="max-width: 800px; height: auto;">`;
      }
      return match;
    });
    
    return optimizedHtml;
  } catch (error) {
    console.error('Error optimizing images:', error);
    // Return original HTML on error rather than failing
    return html;
  }
};

// Route to generate quote PDF
app.post('/generate-quote-pdf', verifyToken, async (req, res) => {
  const startTime = Date.now();
  let browser = null;
  
  try {
    const { quoteId, options } = req.body;
    
    if (!quoteId) {
      return res.status(400).json({ error: 'Quote ID is required' });
    }
    
    console.log(`Starting PDF generation for quote: ${quoteId}`);
    console.log('Generation options:', JSON.stringify(options));
    
    // Generate a unique file name
    const fileId = uuidv4().substring(0, 8);
    
    // Fetch quote data from Supabase
    console.log('Fetching quote data...');
    const quoteData = await fetchQuoteData(quoteId);
    
    // Generate HTML
    console.log('Generating HTML...');
    const html = generateQuoteHtml(quoteData, options);
    
    if (!html) {
      throw new Error('HTML generation failed - html is undefined');
    }
    
    // Optimize images if requested
    console.log('Optimizing HTML...');
    const optimizedHtml = optimizeImages(html, options?.optimizeImages !== false);
    
    // Generate PDF with puppeteer
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: 'new',
    });
    
    console.log('Creating new page...');
    const page = await browser.newPage();
    
    // Set viewport to match page size
    await page.setViewport({
      width: options?.pageSize === 'letter' ? 2550 : 2480,
      height: options?.pageSize === 'letter' ? 3300 : 3508,
      deviceScaleFactor: 2,
    });
    
    console.log('Setting content...');
    // Set a reasonable timeout for content loading
    await page.setContent(optimizedHtml, {
      waitUntil: 'networkidle0',
      timeout: IMAGE_PROCESSING_TIMEOUT,
    });
    
    console.log('Generating PDF...');
    const pdfBuffer = await page.pdf({
      format: options?.pageSize === 'letter' ? 'Letter' : 'A4',
      printBackground: true,
      margin: {
        top: '0.4in',
        right: '0.4in',
        bottom: '0.4in',
        left: '0.4in',
      },
    });
    
    console.log('PDF generated, uploading to storage...');
    
    // Upload PDF to Supabase Storage
    const quoteRef = quoteData.quote.reference || `QT-${fileId}`;
    const fileName = `${quoteRef.replace(/\s+/g, '-')}-${fileId}.pdf`;
    const storagePath = `quote_pdfs/${quoteId}/${fileName}`;
    
    const { data: storageData, error: storageError } = await supabase.storage
      .from('documents')
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });
    
    if (storageError) {
      console.error('Error uploading PDF to storage:', storageError);
      throw new Error(`Failed to upload PDF: ${storageError.message}`);
    }
    
    // Get public URL for the uploaded file
    const { data: urlData } = await supabase.storage
      .from('documents')
      .getPublicUrl(storagePath);
    
    // Add record in the quote_pdfs table
    const version = 1; // In production, you might want to handle versioning
    
    const { data: pdfData, error: pdfError } = await supabase
      .from('quote_pdfs')
      .insert({
        quote_id: quoteId,
        pdf_url: storagePath,
        file_name: fileName,
        version,
        options: options,
        created_by: req.user.id
      })
      .select()
      .single();
    
    if (pdfError) {
      console.warn('Error storing PDF record:', pdfError);
      // Continue anyway as this is not critical
    }
    
    const processingTime = Date.now() - startTime;
    console.log(`PDF generation completed in ${processingTime}ms`);
    
    return res.status(200).json({
      success: true,
      documentUrl: urlData.publicUrl,
      fileName,
      processingTime,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`PDF generation failed after ${processingTime}ms:`, error);
    
    // Return a proper error response
    return res.status(500).json({
      success: false,
      error: error.message || 'PDF generation failed',
      processingTime,
      // Only include stack in development mode
      ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
    });
  } finally {
    // Close the browser
    if (browser) {
      try {
        await browser.close();
        console.log('Browser closed');
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Quote PDF service started on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Memory limits: ${JSON.stringify(process.memoryUsage())}`);
  console.log(`Service ready to accept connections`);
});

