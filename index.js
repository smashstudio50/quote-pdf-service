
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

// Create Supabase client with service role key for storage write access
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Parse allowed origins from environment variable or use default list
const allowedOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',') 
  : [
      'https://aclima.aismartcrew.com',
      'https://e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovableproject.com',
      'https://id-preview--e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovable.app'
    ];

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
  try {
    // Import the HTML template generator function directly
    // In a real implementation, you might want to replicate this function here
    // For now, we'll use a simplified version to demonstrate
    
    const { quote, lineItems, companyProfile, rooms } = quoteData;
    
    // Basic formatting functions
    const formatCurrency = (amount) => {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP',
      }).format(amount);
    };
    
    const formatDate = (dateString) => {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    };
    
    const getAddress = () => {
      if (quote.site_address) return quote.site_address;
      
      return [
        quote.site_address_line1,
        quote.site_address_line2,
        quote.site_city,
        quote.site_postcode,
        quote.site_country
      ].filter(Boolean).join(', ');
    };
    
    // Design settings
    const accentColor = options.accentColor || companyProfile?.quote_accent_color || '#3b82f6';
    const headerText = companyProfile?.quote_header_text || '';
    const footerText = companyProfile?.quote_footer_text || 'Thank you for your business';
    const titlePageHeading = options.titlePage?.heading || companyProfile?.quote_title_page_heading || 'Professional Quotation';
    const titlePageSubheading = options.titlePage?.subheading || companyProfile?.quote_title_page_subheading || quote.reference;
    const titlePageBackgroundUrl = options.titlePage?.backgroundUrl || companyProfile?.quote_title_page_background_url || '';
    
    // Generate rooms section
    const generateRoomsSections = () => {
      if (!rooms || rooms.length === 0) return '';
      
      return `
        <h3 style="color: ${accentColor}; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-top: 30px;">Rooms and Equipment</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 15px; margin-top: 15px;">
          ${rooms.map(room => `
            <div style="border: 1px solid #ddd; border-radius: 5px; padding: 15px; background-color: #fff;">
              <div style="display: flex; align-items: center; margin-bottom: 10px;">
                <span style="font-size: 1.5em; margin-right: 10px;">${room.icon || '🏠'}</span>
                <div>
                  <h4 style="margin: 0; font-size: 16px;">${room.name}</h4>
                  ${room.custom_label ? `<p style="margin: 0; color: #666; font-size: 14px;">${room.custom_label}</p>` : ''}
                </div>
              </div>
              
              ${room.dimensions ? `
                <div style="background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin-bottom: 15px; font-size: 14px;">
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <p style="margin: 0; color: #555;">Width: ${room.dimensions.width}m</p>
                    <p style="margin: 0; color: #555;">Length: ${room.dimensions.length}m</p>
                    <p style="margin: 0; color: #555;">Height: ${room.dimensions.height}m</p>
                    ${room.dimensions.area ? `<p style="margin: 0; color: #555;">Area: ${room.dimensions.area}m²</p>` : ''}
                    ${room.dimensions.volume ? `<p style="margin: 0; color: #555;">Volume: ${room.dimensions.volume}m³</p>` : ''}
                  </div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `;
    };
    
    // Generate HTML
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>${quote.reference} - Quotation</title>
        <style>
          @page {
            size: ${options.pageSize === 'a4' ? 'A4' : 'letter'};
            margin: 0;
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
          
          .page-break {
            page-break-before: always;
          }
        </style>
      </head>
      <body>
        <div class="title-page">
          <div class="title-page-content">
            ${companyProfile?.logo_url ? `<img src="${companyProfile.logo_url}" alt="Company Logo">` : ''}
            <h1>${titlePageHeading}</h1>
            <h2>${titlePageSubheading}</h2>
            <p style="margin-top: 40px; color: #666;">${formatDate(quote.created_at)}</p>
            <p style="color: #666; font-weight: bold;">${quote.customer_name}</p>
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
              <div><strong>Reference:</strong> ${quote.reference}</div>
              <div><strong>Date:</strong> ${formatDate(quote.created_at)}</div>
              <div><strong>Valid until:</strong> ${quote.validity_period || 30} days</div>
            </div>
          </div>
          
          <div class="customer-info">
            <h3>Customer Information</h3>
            <div><strong>Name:</strong> ${quote.customer_name}</div>
            <div><strong>Project Address:</strong> ${getAddress()}</div>
            ${quote.type ? `<div><strong>Project Type:</strong> ${quote.type}</div>` : ''}
            ${quote.building_type ? `<div><strong>Building Type:</strong> ${quote.building_type}</div>` : ''}
          </div>
          
          ${options.includeRooms ? generateRoomsSections() : ''}
          
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
              ${lineItems.map(item => `
                <tr>
                  <td>
                    <strong>${item.description}</strong>
                    ${item.equipment_make && item.equipment_model ? 
                      `<br><span style="font-size: 0.9em; color: #666;">${item.equipment_make} ${item.equipment_model}</span>` : ''}
                  </td>
                  <td>${item.quantity}</td>
                  <td>${formatCurrency(item.unit_price)}</td>
                  <td>${formatCurrency(item.subtotal)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          
          <div class="amount-summary">
            <div><strong>Subtotal:</strong> ${formatCurrency(quote.subtotal)}</div>
            ${quote.tax_amount ? `<div><strong>VAT (${quote.tax_rate}%):</strong> ${formatCurrency(quote.tax_amount)}</div>` : ''}
            ${quote.discount_amount ? `<div><strong>Discount:</strong> ${formatCurrency(quote.discount_amount)}</div>` : ''}
            <div class="total"><strong>Total:</strong> ${formatCurrency(quote.total_amount)}</div>
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
    
    return html;
  } catch (error) {
    console.error('Error generating HTML:', error);
    throw error;
  }
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
    const html = await generateQuoteHtml(quoteData, options || {});
    
    if (!html) {
      throw new Error('HTML generation failed - html is undefined');
    }
    
    // Save HTML to temp file (for debugging)
    tempHtmlPath = path.join(tempDir, `quote-${quoteId}-${Date.now()}.html`);
    fs.writeFileSync(tempHtmlPath, html, 'utf8');
    console.log(`HTML saved to ${tempHtmlPath}`);
    
    // IMPROVED: Optimized Puppeteer configuration for image loading
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
      timeout: 60000, // 60 second timeout
    });
    
    console.log('Browser launched successfully');
    
    // Create new page with more verbose error logging
    console.log('Creating new page...');
    const page = await browser.newPage();
    
    // MODIFIED: Allow images but limit other resource types
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
    
    console.log('Page created and configured');
    
    // Add page error event listeners for better debugging
    page.on('error', err => {
      console.error('Page error:', err);
    });
    
    page.on('pageerror', err => {
      console.error('Page JS error:', err);
    });
    
    page.on('console', msg => {
      console.log('Page console message:', msg.text());
    });
    
    // Set content with stepped approach for more stable rendering
    console.log('Setting page content...');
    try {
      await page.setContent(html, { 
        waitUntil: ['domcontentloaded', 'networkidle0'],
        timeout: 30000
      });
      
      // Wait for all images to load
      await page.evaluate(() => {
        return new Promise((resolve) => {
          const imgs = document.querySelectorAll('img');
          if (imgs.length === 0) {
            return resolve();
          }
          
          let loadedImages = 0;
          const imageLoaded = () => {
            loadedImages++;
            if (loadedImages === imgs.length) {
              resolve();
            }
          };
          
          imgs.forEach(img => {
            if (img.complete) {
              imageLoaded();
            } else {
              img.addEventListener('load', imageLoaded);
              img.addEventListener('error', imageLoaded); // Still continue on error
            }
          });
        });
      });
      
      // Wait for network to be idle and all content to load
      await page.waitForFunction(() => document.readyState === 'complete', {
        timeout: 30000
      });
      
      console.log('Page content set successfully');
    } catch (contentError) {
      console.error('Error setting page content:', contentError);
      throw new Error(`Failed to set page content: ${contentError.message}`);
    }
    
    // Set PDF options with better margins for A4
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
      timeout: 60000, // 60 second timeout for PDF generation
      omitBackground: false,
      scale: 1
    };
    
    // Generate PDF with stepped approach and error handling
    console.log('Generating PDF with options:', pdfOptions);
    let pdfBuffer;
    try {
      // Force a small delay to ensure all content is rendered
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
      
      // Generate the PDF with explicit error handling
      pdfBuffer = await Promise.race([
        page.pdf(pdfOptions),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('PDF generation timeout after 60s')), 60000)
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
    
    // Write PDF file with more robust error handling
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
    
    // Return detailed error with stack trace for debugging
    res.status(500).json({
      error: 'Failed to generate PDF',
      message: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
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
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        console.log('Manual garbage collection triggered');
      }
    } catch (err) {
      console.error('Error logging memory usage:', err);
    }
    
    // Keep temp files for debugging
    console.log('Temp files kept for debugging:');
    if (tempHtmlPath) console.log(`- HTML: ${tempHtmlPath}`);
    if (tempPdfPath) console.log(`- PDF: ${tempPdfPath}`);
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Quote PDF service running on port ${PORT}`);
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS configuration: ${process.env.CORS_ORIGIN || '*'}`);
});
