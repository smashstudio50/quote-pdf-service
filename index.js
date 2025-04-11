// index.js
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

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', true);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : [
      'https://aclima.aismartcrew.com',
      'https://e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovableproject.com',
      'https://id-preview--e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovable.app'
    ];

console.log('Server starting with CORS configuration:');
console.log('Allowed origins:', allowedOrigins);

const corsOptions = {
  origin: function (origin, callback) {
    console.log('Request origin:', origin);
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    const isRelated = allowedOrigins.some(o => origin.includes(o) || o.includes(origin));
    if (isRelated) return callback(null, true);

    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info', 'ApiKey'],
  credentials: true,
  maxAge: 86400
};

app.use(cors(corsOptions));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, ApiKey');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

app.options('*', (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, ApiKey');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  return res.sendStatus(200);
});

// ... your middleware, verifyToken, fetchQuoteData, generateQuoteHtml, and main route remain unchanged

app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/test-cors', (req, res) => {
  res.json({
    success: true,
    message: 'CORS test successful',
    origin: req.headers.origin || 'No origin header'
  });
});

app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Memory usage at startup: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
});
