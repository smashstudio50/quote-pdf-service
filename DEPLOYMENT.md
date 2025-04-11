
# Deployment Guide for Quote PDF Microservice

This document outlines various options for deploying the PDF generation microservice.

## Prerequisites
- Node.js 16+
- npm or yarn
- Supabase account with storage bucket set up

## Option 1: Deploy to Render

[Render](https://render.com/) offers easy deployment for Node.js services.

1. Create a new Web Service in Render
2. Connect your GitHub repository
3. Set the following options:
   - **Name**: quote-pdf-service
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
4. Add these environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `CORS_ORIGIN`
5. Click "Create Web Service"

## Option 2: Deploy to Railway

[Railway](https://railway.app/) offers simple deployment with automatic builds.

1. Create a new project in Railway
2. Connect your GitHub repository
3. Add these environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `CORS_ORIGIN`
4. Deploy

## Option 3: Deploy with Docker

You can deploy the Docker container to any container hosting service.

1. Build the Docker image:
   ```
   docker build -t quote-pdf-service .
   ```

2. Run the container:
   ```
   docker run -p 3000:3000 \
     -e SUPABASE_URL=your-supabase-url \
     -e SUPABASE_SERVICE_KEY=your-service-key \
     -e CORS_ORIGIN=your-frontend-url \
     quote-pdf-service
   ```

## Option 4: Deploy to Digital Ocean App Platform

1. Create a new app in Digital Ocean
2. Connect your GitHub repository
3. Configure the app as a Web Service
4. Add the environment variables
5. Deploy

## Configuring Your Frontend Application

After deploying the microservice, you need to update your frontend application with the service URL.

1. Add the `VITE_PDF_SERVICE_URL` environment variable to your frontend project:
   ```
   VITE_PDF_SERVICE_URL=https://your-microservice-url.com
   ```

2. Verify the service is working by checking the health endpoint:
   ```
   https://your-microservice-url.com/health
   ```

## Security Considerations

- Always use HTTPS for your production endpoint
- Ensure Supabase authentication is properly set up
- Use a service role key with minimal permissions
- Set appropriate CORS origins to prevent unauthorized access

## Monitoring and Maintenance

- Check logs regularly for errors
- Set up monitoring for the service
- Consider adding error reporting to a service like Sentry

## Troubleshooting

If you encounter issues:

1. Check the service logs
2. Verify environment variables are set correctly
3. Ensure Supabase storage bucket permissions are correct
4. Check browser console in frontend for CORS errors
