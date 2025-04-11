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

// Configure Express to trust the Render.com proxy
app.set('trust proxy', 1);

// Create Supabase client with service role key for storage write access
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Create temp directory for files if it doesn't exist
const tempDir = path.join(os.tmpdir(), 'quote-pdfs');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Middleware
app.use(helmet());
app.use(express.json({ limit: '20mb' }));
app.use(morgan('combined'));
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Log the CORS origins being used
console.log('CORS Origins:', process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*');
// Handle preflight requests
app.options('*', cors());

// Apply rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: true }, // Trust proxy for rate limiting
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/generate-quote-pdf', limiter);

// Root route handler for health checks
app.get('/', (req, res) => {
  res.json({
    service: 'Quote PDF Generator',
    status: 'running',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// Expanded health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check Supabase connection
    const { data, error } = await supabase.from('quotes').select('id').limit(1);
    
    // Check if quote_pdfs bucket exists
    const { data: bucketData, error: bucketError } = await supabase.storage
      .getBucket('quote_pdfs');
    
    // Check puppeteer by launching a minimal browser
    let browserCheck = 'failed';
    try {
      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: 'new'
      });
      await browser.close();
      browserCheck = 'ok';
    } catch (err) {
      console.error('Puppeteer health check failed:', err);
    }
    
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      memory: process.memoryUsage(),
      supabase: error ? 'error' : 'connected',
      storage: bucketError ? 'error' : 'connected',
      puppeteer: browserCheck,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

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
    return `
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
  } catch (error) {
    console.error('Error generating HTML:', error);
    throw error;
  }
};

// Main endpoint for generating quote PDFs
app.post('/generate-quote-pdf', verifyToken, async (req, res) => {
  console.log('PDF generation request received');
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
    
    // Fetch all necessary data for the quote
    const quoteData = await fetchQuoteData(quoteId);
    console.log(`Successfully fetched data for quote ${quoteId}`);
    
    // Generate HTML for the quote
    const html = await generateQuoteHtml(quoteData, options);
    
    // Save HTML to temp file (for debugging)
    tempHtmlPath = path.join(tempDir, `quote-${quoteId}-${Date.now()}.html`);
    fs.writeFileSync(tempHtmlPath, html);
    console.log(`HTML saved to ${tempHtmlPath}`);
    
    // Launch puppeteer with improved options for containerized environments
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
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

// Set up graceful shutdown to prevent memory leaks
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  app.close(() => {
    console.log('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  app.close(() => {
    console.log('HTTP server closed');
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Quote PDF service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
