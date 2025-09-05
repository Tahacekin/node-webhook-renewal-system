const express = require('express');
const session = require('express-session');
const { Client } = require('@microsoft/microsoft-graph-client');
const axios = require('axios');
const crypto = require('crypto');
const { Sequelize } = require('sequelize');
const { Subscription } = require('./models');
const renewalService = require('./services/renewalService');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

// Database connection
let sequelize;
if (process.env.DATABASE_URL) {
  // Production (Heroku) - use DATABASE_URL
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    }
  });
} else {
  // Development - use individual variables
  sequelize = new Sequelize(
    process.env.DB_NAME || 'webhook_renewal',
    process.env.DB_USER || 'webhook_user',
    process.env.DB_PASSWORD || 'your_secure_password',
    {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      dialect: 'postgres',
      logging: false
    }
  );
}

// Test database connection
sequelize.authenticate()
  .then(() => {
    console.log('Database connection established successfully.');
  })
  .catch(err => {
    console.error('Unable to connect to the database:', err);
  });

// Microsoft Graph API configuration
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-app-name.up.railway.app'}` : 'http://localhost:3000');
const REDIRECT_URI = `${APP_URL}/callback`;
// Dynamic webhook URL based on environment
const WEBHOOK_URL = process.env.WEBHOOK_URL || `${APP_URL}/webhook`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// FORENSIC LOGGING: Environment variables verification
console.log('🔍 [ENV DEBUG] ===== ENVIRONMENT VARIABLES =====');
console.log('🔍 [ENV DEBUG] NODE_ENV:', process.env.NODE_ENV);
console.log('🔍 [ENV DEBUG] CLIENT_ID:', CLIENT_ID ? `${CLIENT_ID.substring(0, 8)}...${CLIENT_ID.substring(CLIENT_ID.length - 4)}` : 'UNDEFINED');
console.log('🔍 [ENV DEBUG] CLIENT_SECRET:', CLIENT_SECRET ? `${CLIENT_SECRET.substring(0, 8)}...${CLIENT_SECRET.substring(CLIENT_SECRET.length - 4)}` : 'UNDEFINED');
console.log('🔍 [ENV DEBUG] APP_URL:', APP_URL);
console.log('🔍 [ENV DEBUG] REDIRECT_URI:', REDIRECT_URI);
console.log('🔍 [ENV DEBUG] WEBHOOK_URL:', WEBHOOK_URL);
console.log('🔍 [ENV DEBUG] WEBHOOK_SECRET:', WEBHOOK_SECRET ? `${WEBHOOK_SECRET.substring(0, 8)}...${WEBHOOK_SECRET.substring(WEBHOOK_SECRET.length - 4)}` : 'UNDEFINED');
console.log('🔍 [ENV DEBUG] RAILWAY_PUBLIC_DOMAIN:', process.env.RAILWAY_PUBLIC_DOMAIN || 'UNDEFINED');
console.log('🔍 [ENV DEBUG] =================================');

// Helper function to refresh access token
async function refreshAccessToken(refreshToken) {
  try {
    console.log('🔍 [TOKEN DEBUG] Attempting to refresh access token...');
    const tokenResponse = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Read offline_access'
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    const { access_token, refresh_token: new_refresh_token } = tokenResponse.data;
    console.log('🔍 [TOKEN DEBUG] ✅ Token refreshed successfully');
    return { access_token, refresh_token: new_refresh_token };
  } catch (error) {
    console.error('🔍 [TOKEN DEBUG] ❌ Token refresh failed:', error.response?.data || error.message);
    throw error;
  }
}

// Helper function to get Graph client with automatic token refresh
async function getGraphClientWithRefresh(req, res) {
  let accessToken = req.session.accessToken;
  
  // If no access token, redirect to login immediately
  if (!accessToken) {
    console.log('🔍 [TOKEN DEBUG] ❌ No access token in session, redirecting to login');
    res.redirect('/login');
    return null;
  }
  
  try {
    // First, try to use the current token
    const graphClient = Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      }
    });
    
    // Test the token by making a simple API call
    console.log('🔍 [TOKEN DEBUG] Testing token with /me API call...');
    const userInfo = await graphClient.api('/me').get();
    console.log('🔍 [TOKEN DEBUG] ✅ Current token is valid');
    console.log('🔍 [TOKEN DEBUG] User info:', JSON.stringify(userInfo, null, 2));
    return graphClient;
    
  } catch (error) {
    console.log('🔍 [TOKEN DEBUG] ❌ Current token is invalid, attempting refresh...');
    console.log('🔍 [TOKEN DEBUG] Error details:', error.message);
    console.log('🔍 [TOKEN DEBUG] Error status:', error.statusCode);
    console.log('🔍 [TOKEN DEBUG] Error code:', error.code);
    
    // If we have a refresh token, try to refresh
    if (req.session.refreshToken) {
      try {
        console.log('🔍 [TOKEN DEBUG] Attempting token refresh...');
        const { access_token, refresh_token } = await refreshAccessToken(req.session.refreshToken);
        
        console.log('🔍 [TOKEN DEBUG] ✅ Token refresh successful');
        console.log('🔍 [TOKEN DEBUG] New access token preview:', access_token ? `${access_token.substring(0, 10)}...${access_token.substring(access_token.length - 10)}` : 'UNDEFINED');
        
        // Update session with new tokens
        req.session.accessToken = access_token;
        req.session.refreshToken = refresh_token;
        
        // Test the new token immediately
        console.log('🔍 [TOKEN DEBUG] Testing refreshed token...');
        const newGraphClient = Client.init({
          authProvider: (done) => {
            done(null, access_token);
          }
        });
        
        const testUserInfo = await newGraphClient.api('/me').get();
        console.log('🔍 [TOKEN DEBUG] ✅ Refreshed token is valid');
        console.log('🔍 [TOKEN DEBUG] User info from refreshed token:', JSON.stringify(testUserInfo, null, 2));
        
        return newGraphClient;
        
      } catch (refreshError) {
        console.error('🔍 [TOKEN DEBUG] ❌ Token refresh failed');
        console.error('🔍 [TOKEN DEBUG] Refresh error status:', refreshError.response?.status);
        console.error('🔍 [TOKEN DEBUG] Refresh error data:', refreshError.response?.data);
        console.error('🔍 [TOKEN DEBUG] Refresh error message:', refreshError.message);
        
        // Clear invalid tokens from session
        req.session.accessToken = null;
        req.session.refreshToken = null;
        
        res.redirect('/login');
        return null;
      }
    } else {
      console.error('🔍 [TOKEN DEBUG] ❌ No refresh token available, redirecting to login');
      console.error('🔍 [TOKEN DEBUG] This usually means the OAuth scope did not include "offline_access"');
      
      // Clear invalid tokens from session
      req.session.accessToken = null;
      req.session.refreshToken = null;
      
      res.redirect('/login');
      return null;
    }
  }
}

// Helper function to get Graph client (legacy - for backward compatibility)
function getGraphClient(accessToken) {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    }
  });
}

// Part 1: Authentication Routes

// Authentication status check route
app.get('/auth-status', (req, res) => {
  console.log('🔍 [AUTH DEBUG] ===== AUTHENTICATION STATUS CHECK =====');
  console.log('🔍 [AUTH DEBUG] Session ID:', req.sessionID);
  console.log('🔍 [AUTH DEBUG] Has access token:', !!req.session.accessToken);
  console.log('🔍 [AUTH DEBUG] Access token preview:', req.session.accessToken ? 
    `${req.session.accessToken.substring(0, 10)}...${req.session.accessToken.substring(req.session.accessToken.length - 10)}` : 
    'UNDEFINED');
  console.log('🔍 [AUTH DEBUG] Session data:', JSON.stringify(req.session, null, 2));
  console.log('🔍 [AUTH DEBUG] ======================================');
  
  res.json({
    authenticated: !!req.session.accessToken,
    hasToken: !!req.session.accessToken,
    tokenPreview: req.session.accessToken ? 
      `${req.session.accessToken.substring(0, 10)}...${req.session.accessToken.substring(req.session.accessToken.length - 10)}` : 
      'UNDEFINED',
    sessionId: req.sessionID
  });
});

// Simple test endpoint to test Microsoft Graph API directly
app.get('/test-graph', async (req, res) => {
  console.log('🔍 [GRAPH TEST] ===== DIRECT GRAPH API TEST =====');
  
  if (!req.session.accessToken) {
    console.log('🔍 [GRAPH TEST] ❌ No access token, redirecting to login');
    return res.redirect('/login');
  }
  
  try {
    console.log('🔍 [GRAPH TEST] Testing direct Graph API call...');
    console.log('🔍 [GRAPH TEST] Using token:', req.session.accessToken.substring(0, 20) + '...');
    
    // Test with direct axios call first
    console.log('🔍 [GRAPH TEST] Testing with direct axios call...');
    const directResponse = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: {
        'Authorization': `Bearer ${req.session.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('🔍 [GRAPH TEST] ✅ Direct axios call successful');
    console.log('🔍 [GRAPH TEST] Response status:', directResponse.status);
    console.log('🔍 [GRAPH TEST] User data:', JSON.stringify(directResponse.data, null, 2));
    
    res.json({
      success: true,
      message: 'Direct Graph API call successful',
      user: directResponse.data,
      method: 'direct_axios'
    });
    
  } catch (error) {
    console.error('🔍 [GRAPH TEST] ❌ Direct Graph API call failed');
    console.error('🔍 [GRAPH TEST] Error type:', error.constructor.name);
    console.error('🔍 [GRAPH TEST] Error message:', error.message);
    console.error('🔍 [GRAPH TEST] Error status:', error.response?.status);
    console.error('🔍 [GRAPH TEST] Error data:', error.response?.data);
    console.error('🔍 [GRAPH TEST] Full error:', JSON.stringify(error, null, 2));
    
    // Try with Microsoft Graph client as fallback
    try {
      console.log('🔍 [GRAPH TEST] Trying with Microsoft Graph client...');
      const graphClient = Client.init({
        authProvider: (done) => {
          done(null, req.session.accessToken);
        }
      });
      
      const user = await graphClient.api('/me').get();
      console.log('🔍 [GRAPH TEST] ✅ Graph client call successful');
      
      res.json({
        success: true,
        message: 'Graph client call successful',
        user: user,
        method: 'graph_client'
      });
      
    } catch (clientError) {
      console.error('🔍 [GRAPH TEST] ❌ Graph client also failed');
      console.error('🔍 [GRAPH TEST] Client error:', clientError.message);
      
      res.status(500).json({
        success: false,
        error: 'Both direct and client calls failed',
        directError: {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data
        },
        clientError: {
          message: clientError.message,
          status: clientError.statusCode,
          code: clientError.code
        }
      });
    }
  }
});

// Login route - redirects to Microsoft login
app.get('/login', (req, res) => {
  console.log('🔍 [LOGIN DEBUG] ===== LOGIN ROUTE TRIGGERED =====');
  console.log('🔍 [LOGIN DEBUG] CLIENT_ID:', CLIENT_ID ? `${CLIENT_ID.substring(0, 8)}...${CLIENT_ID.substring(CLIENT_ID.length - 4)}` : 'UNDEFINED');
  console.log('🔍 [LOGIN DEBUG] REDIRECT_URI:', REDIRECT_URI);
  
  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    `client_id=${CLIENT_ID}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `response_mode=query&` +
    `scope=https://graph.microsoft.com/Mail.Read offline_access&` +
    `state=12345`;
  
  console.log('🔍 [LOGIN DEBUG] Auth URL:', authUrl);
  console.log('🔍 [LOGIN DEBUG] =================================');
  
  res.redirect(authUrl);
});

// Callback route - handles the authorization code exchange
app.get('/callback', async (req, res) => {
  console.log('🔍 [CALLBACK DEBUG] ===== CALLBACK ROUTE TRIGGERED =====');
  console.log('🔍 [CALLBACK DEBUG] Query params:', JSON.stringify(req.query, null, 2));
  
  const { code, error } = req.query;
  
  if (error) {
    console.error('🔍 [CALLBACK DEBUG] ❌ OAuth error:', error);
    return res.status(400).json({ error: 'Authentication failed', details: error });
  }
  
  if (!code) {
    console.error('🔍 [CALLBACK DEBUG] ❌ No authorization code received');
    return res.status(400).json({ error: 'No authorization code received' });
  }
  
  try {
    console.log('🔍 [CALLBACK DEBUG] Exchanging authorization code for tokens...');
    console.log('🔍 [CALLBACK DEBUG] CLIENT_ID:', CLIENT_ID ? `${CLIENT_ID.substring(0, 8)}...${CLIENT_ID.substring(CLIENT_ID.length - 4)}` : 'UNDEFINED');
    console.log('🔍 [CALLBACK DEBUG] CLIENT_SECRET:', CLIENT_SECRET ? `${CLIENT_SECRET.substring(0, 8)}...${CLIENT_SECRET.substring(CLIENT_SECRET.length - 4)}` : 'UNDEFINED');
    console.log('🔍 [CALLBACK DEBUG] REDIRECT_URI:', REDIRECT_URI);
    
    // Exchange authorization code for access token
    const tokenResponse = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      scope: 'https://graph.microsoft.com/Mail.Read offline_access'
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    console.log('🔍 [CALLBACK DEBUG] ✅ Token exchange successful');
    console.log('🔍 [CALLBACK DEBUG] Response status:', tokenResponse.status);
    
    const { access_token, refresh_token } = tokenResponse.data;
    
    console.log('🔍 [CALLBACK DEBUG] Access token preview:', access_token ? `${access_token.substring(0, 10)}...${access_token.substring(access_token.length - 10)}` : 'UNDEFINED');
    console.log('🔍 [CALLBACK DEBUG] Refresh token preview:', refresh_token ? `${refresh_token.substring(0, 10)}...${refresh_token.substring(refresh_token.length - 10)}` : 'UNDEFINED');
    
    // Check if refresh token is available
    if (!refresh_token) {
      console.warn('🔍 [CALLBACK DEBUG] ⚠️ No refresh token received - this may cause issues with token renewal');
    }
    
    // Store tokens in session
    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;
    
    console.log('🔍 [CALLBACK DEBUG] ✅ Tokens stored in session');
    console.log('🔍 [CALLBACK DEBUG] Redirecting to home page...');
    console.log('🔍 [CALLBACK DEBUG] ======================================');
    
    res.redirect('/');
  } catch (error) {
    console.error('🔍 [CALLBACK DEBUG] ❌ Token exchange error:');
    console.error('🔍 [CALLBACK DEBUG] Error status:', error.response?.status);
    console.error('🔍 [CALLBACK DEBUG] Error data:', error.response?.data);
    console.error('🔍 [CALLBACK DEBUG] Error message:', error.message);
    console.error('🔍 [CALLBACK DEBUG] ======================================');
    
    res.status(500).json({ error: 'Token exchange failed', details: error.message });
  }
});

// Part 2: Manual Email Fetching

// API endpoint to fetch emails
app.get('/fetch-emails', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated. Please login first.' });
  }
  
  try {
    // Use the new token refresh mechanism
    const graphClient = await getGraphClientWithRefresh(req, res);
    
    // If graphClient is null, it means we redirected to login
    if (!graphClient) {
      return; // Exit early, redirect already happened
    }
    
    // Fetch the top 10 most recent emails
    const messages = await graphClient
      .api('/me/messages')
      .select('subject,receivedDateTime,from,isRead')
      .top(10)
      .orderby('receivedDateTime desc')
      .get();
    
    res.json({
      success: true,
      emails: messages.value.map(email => ({
        subject: email.subject,
        receivedDateTime: email.receivedDateTime,
        from: email.from?.emailAddress?.name || 'Unknown',
        isRead: email.isRead
      }))
    });
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ 
      error: 'Failed to fetch emails',
      details: error.message 
    });
  }
});

// Part 3: Webhook Implementation

// Manual test route for debugging subscription creation
app.get('/test-subscription', async (req, res) => {
  console.log('🔍 [TEST DEBUG] ===== MANUAL SUBSCRIPTION TEST TRIGGERED =====');
  console.log('🔍 [TEST DEBUG] Request from IP:', req.ip);
  console.log('🔍 [TEST DEBUG] User-Agent:', req.get('User-Agent'));
  console.log('🔍 [TEST DEBUG] ==============================================');
  
  if (!req.session.accessToken) {
    console.log('🔍 [TEST DEBUG] ❌ No access token found - redirecting to login');
    return res.redirect('/login');
  }
  
  try {
    console.log('🔍 [TEST DEBUG] Starting subscription creation test...');
    
    // Try direct approach first - bypass complex token refresh
    console.log('🔍 [TEST DEBUG] Testing direct Graph API approach...');
    
    // Test user info first
    const userResponse = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: {
        'Authorization': `Bearer ${req.session.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('🔍 [TEST DEBUG] ✅ Direct user API call successful');
    const user = userResponse.data;
    const userId = user.id;
    console.log('🔍 [TEST DEBUG] User ID:', userId);
    console.log('🔍 [TEST DEBUG] User display name:', user.displayName);
    
    // Test webhook URL accessibility
    console.log('🔍 [TEST DEBUG] Testing webhook URL accessibility...');
    try {
      const webhookTest = await axios.get(WEBHOOK_URL + '?validationToken=test123');
      console.log('🔍 [TEST DEBUG] ✅ Webhook URL is accessible, status:', webhookTest.status);
    } catch (webhookError) {
      console.error('🔍 [TEST DEBUG] ❌ Webhook URL test failed:', webhookError.message);
    }
    
    // Create subscription using direct API call
    console.log('🔍 [TEST DEBUG] Creating subscription with direct API call...');
    const subscriptionData = {
      changeType: 'created',
      notificationUrl: WEBHOOK_URL,
      resource: '/me/messages',
      expirationDateTime: new Date(Date.now() + 1 * 60 * 1000).toISOString(), // 1 minute for testing
      clientState: WEBHOOK_SECRET
    };
    
    console.log('🔍 [TEST DEBUG] Subscription data:', JSON.stringify(subscriptionData, null, 2));
    
    const subscriptionResponse = await axios.post('https://graph.microsoft.com/v1.0/subscriptions', subscriptionData, {
      headers: {
        'Authorization': `Bearer ${req.session.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('🔍 [TEST DEBUG] ✅ Subscription created successfully!');
    console.log('🔍 [TEST DEBUG] Subscription ID:', subscriptionResponse.data.id);
    console.log('🔍 [TEST DEBUG] Expiration:', subscriptionResponse.data.expirationDateTime);
    
    // Store subscription in database
    console.log('🔍 [TEST DEBUG] Storing subscription in database...');
    const dbSubscription = await Subscription.create({
      subscriptionId: subscriptionResponse.data.id,
      expirationDateTime: new Date(subscriptionResponse.data.expirationDateTime),
      userId: userId
    });
    console.log('🔍 [TEST DEBUG] ✅ Database record created with ID:', dbSubscription.id);
    
    // Store subscription ID in session for management
    req.session.subscriptionId = subscriptionResponse.data.id;
    
    res.json({
      success: true,
      message: 'Subscription created successfully via direct API call',
      subscription: {
        id: subscriptionResponse.data.id,
        expirationDateTime: subscriptionResponse.data.expirationDateTime
      },
      user: {
        id: userId,
        displayName: user.displayName
      },
      debug: {
        webhookUrl: WEBHOOK_URL,
        appUrl: APP_URL,
        method: 'direct_api'
      }
    });
    
  } catch (error) {
    console.error('🔍 [TEST DEBUG] ===== DIRECT API ERROR DETAILS =====');
    console.error('🔍 [TEST DEBUG] Error type:', error.constructor.name);
    console.error('🔍 [TEST DEBUG] Error message:', error.message);
    console.error('🔍 [TEST DEBUG] Error status:', error.response?.status);
    console.error('🔍 [TEST DEBUG] Error data:', error.response?.data);
    console.error('🔍 [TEST DEBUG] Full error:', JSON.stringify(error, null, 2));
    console.error('🔍 [TEST DEBUG] ======================================');
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to create subscription via direct API call',
      details: error.message,
      debug: {
        type: error.constructor.name,
        status: error.response?.status,
        data: error.response?.data,
        webhookUrl: WEBHOOK_URL,
        appUrl: APP_URL
      }
    });
  }
});

// Create subscription endpoint
app.post('/create-subscription', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated. Please login first.' });
  }
  
  try {
    // Use the new token refresh mechanism
    const graphClient = await getGraphClientWithRefresh(req, res);
    
    // If graphClient is null, it means we redirected to login
    if (!graphClient) {
      return; // Exit early, redirect already happened
    }
    
    // FORENSIC LOGGING: Access token verification
    const tokenPreview = req.session.accessToken ? 
      `${req.session.accessToken.substring(0, 10)}...${req.session.accessToken.substring(req.session.accessToken.length - 10)}` : 
      'UNDEFINED';
    console.log('🔍 [SUBSCRIPTION DEBUG] Access token preview:', tokenPreview);
    
    // Get user info to store with subscription
    console.log('🔍 [SUBSCRIPTION DEBUG] Fetching user info...');
    console.log('🔍 [SUBSCRIPTION DEBUG] Using Graph client with token:', tokenPreview);
    const user = await graphClient.api('/me').get();
    const userId = user.id;
    console.log('🔍 [SUBSCRIPTION DEBUG] User ID:', userId);
    console.log('🔍 [SUBSCRIPTION DEBUG] User display name:', user.displayName);
    
    // FORENSIC LOGGING: Request preparation
    const requestBody = {
      changeType: 'created',
      notificationUrl: WEBHOOK_URL,
      resource: '/me/messages',
      expirationDateTime: new Date(Date.now() + 1 * 60 * 1000).toISOString(), // 1 minute for testing
      clientState: WEBHOOK_SECRET
    };
    
    console.log('🔍 [SUBSCRIPTION DEBUG] ===== MICROSOFT GRAPH REQUEST DETAILS =====');
    console.log('🔍 [SUBSCRIPTION DEBUG] Endpoint URL: https://graph.microsoft.com/v1.0/subscriptions');
    console.log('🔍 [SUBSCRIPTION DEBUG] Request Headers:');
    console.log('🔍 [SUBSCRIPTION DEBUG] - Authorization: Bearer', tokenPreview);
    console.log('🔍 [SUBSCRIPTION DEBUG] - Content-Type: application/json');
    console.log('🔍 [SUBSCRIPTION DEBUG] Request Body:', JSON.stringify(requestBody, null, 2));
    console.log('🔍 [SUBSCRIPTION DEBUG] ===========================================');
    
    // Test webhook URL accessibility
    console.log('🔍 [SUBSCRIPTION DEBUG] Testing webhook URL accessibility...');
    try {
      const webhookTest = await axios.get(WEBHOOK_URL + '?validationToken=test123');
      console.log('🔍 [SUBSCRIPTION DEBUG] ✅ Webhook URL is accessible, status:', webhookTest.status);
    } catch (webhookError) {
      console.error('🔍 [SUBSCRIPTION DEBUG] ❌ Webhook URL test failed:', webhookError.message);
    }
    
    // Create a subscription for new mail notifications
    console.log('🔍 [SUBSCRIPTION DEBUG] Making API call to Microsoft Graph...');
    const subscription = await graphClient
      .api('/subscriptions')
      .post(requestBody);
    
    console.log('🔍 [SUBSCRIPTION DEBUG] ✅ Subscription created successfully!');
    console.log('🔍 [SUBSCRIPTION DEBUG] Subscription ID:', subscription.id);
    console.log('🔍 [SUBSCRIPTION DEBUG] Expiration:', subscription.expirationDateTime);
    
    // Store subscription in database
    console.log('🔍 [SUBSCRIPTION DEBUG] Storing subscription in database...');
    const dbSubscription = await Subscription.create({
      subscriptionId: subscription.id,
      expirationDateTime: new Date(subscription.expirationDateTime),
      userId: userId
    });
    console.log('🔍 [SUBSCRIPTION DEBUG] ✅ Database record created with ID:', dbSubscription.id);
    
    // Store subscription ID in session for management
    req.session.subscriptionId = subscription.id;
    
    res.json({
      success: true,
      subscription: {
        id: subscription.id,
        expirationDateTime: subscription.expirationDateTime
      }
    });
  } catch (error) {
    console.error('🔍 [SUBSCRIPTION DEBUG] ===== MICROSOFT GRAPH ERROR DETAILS =====');
    console.error('🔍 [SUBSCRIPTION DEBUG] Error type:', error.constructor.name);
    console.error('🔍 [SUBSCRIPTION DEBUG] Error message:', error.message);
    console.error('🔍 [SUBSCRIPTION DEBUG] Error status:', error.statusCode || 'N/A');
    console.error('🔍 [SUBSCRIPTION DEBUG] Error code:', error.code || 'N/A');
    console.error('🔍 [SUBSCRIPTION DEBUG] Error requestId:', error.requestId || 'N/A');
    console.error('🔍 [SUBSCRIPTION DEBUG] Full error object:', JSON.stringify(error, null, 2));
    
    // Check for nested error details
    if (error.response) {
      console.error('🔍 [SUBSCRIPTION DEBUG] Response status:', error.response.status);
      console.error('🔍 [SUBSCRIPTION DEBUG] Response headers:', error.response.headers);
      console.error('🔍 [SUBSCRIPTION DEBUG] Response data:', JSON.stringify(error.response.data, null, 2));
    }
    
    if (error.body) {
      console.error('🔍 [SUBSCRIPTION DEBUG] Error body:', JSON.stringify(error.body, null, 2));
    }
    
    console.error('🔍 [SUBSCRIPTION DEBUG] =========================================');
    
    res.status(500).json({ 
      error: 'Failed to create subscription',
      details: error.message,
      debug: {
        type: error.constructor.name,
        status: error.statusCode,
        code: error.code,
        requestId: error.requestId
      }
    });
  }
});

// Webhook endpoint for receiving notifications
app.post('/webhook', async (req, res) => {
  console.log('🔍 [WEBHOOK DEBUG] ===== WEBHOOK REQUEST RECEIVED =====');
  console.log('🔍 [WEBHOOK DEBUG] Method:', req.method);
  console.log('🔍 [WEBHOOK DEBUG] URL:', req.url);
  console.log('🔍 [WEBHOOK DEBUG] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('🔍 [WEBHOOK DEBUG] Query params:', JSON.stringify(req.query, null, 2));
  console.log('🔍 [WEBHOOK DEBUG] Body:', JSON.stringify(req.body, null, 2));
  
  const validationToken = req.query.validationToken;
  
  // Handle initial validation request
  if (validationToken) {
    console.log('🔍 [WEBHOOK DEBUG] ✅ Validation token received:', validationToken);
    console.log('🔍 [WEBHOOK DEBUG] Responding with 200 OK and validation token');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(validationToken);
  }
  
  // Handle notification
  const notifications = req.body.value;
  if (!notifications || !Array.isArray(notifications)) {
    return res.status(400).json({ error: 'Invalid notification format' });
  }
  
  console.log(`Received ${notifications.length} notification(s)`);
  
  // Process each notification
  for (const notification of notifications) {
    try {
      // Verify the client state if needed
      if (notification.clientState !== WEBHOOK_SECRET) {
        console.warn('Invalid client state in notification');
        continue;
      }
      
      // Get the resource (email) that triggered the notification
      const resource = notification.resource;
      console.log('New email notification for resource:', resource);
      
      // Here you could fetch the specific email details
      // For now, we'll just log the notification
      console.log('Notification details:', {
        changeType: notification.changeType,
        resource: resource,
        clientState: notification.clientState
      });
      
    } catch (error) {
      console.error('Error processing notification:', error);
    }
  }
  
  res.status(200).json({ success: true });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start renewal service
renewalService.start();

// Manual renewal endpoint for testing
app.post('/manual-renewal', async (req, res) => {
  try {
    await renewalService.manualRenewalCheck();
    res.json({ success: true, message: 'Manual renewal check completed' });
  } catch (error) {
    console.error('Manual renewal error:', error);
    res.status(500).json({ error: 'Manual renewal failed', details: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to start`);
});

module.exports = app;
