# Music Guesser - Deployment Guide

## Project Overview
Music Guesser is a real-time multiplayer game where players take turns playing songs and others guess the title and artist.

## Architecture
- **Frontend**: Angular 19 (TypeScript)
- **Backend**: Node.js with Express and Socket.IO
- **Authentication**: Spotify Authorization Code Flow
- **Real-time Communication**: Socket.IO

## Prerequisites
- Node.js (v18 or higher)
- npm or yarn
- Spotify Developer Account with app credentials

## Environment Variables

### Backend (.env file in src/backend/)
```env
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REDIRECT_URI=http://your-backend-domain.com/auth/callback
PORT=3000
```

### Frontend (src/environments/environment.prod.ts)
```typescript
export const environment = {
  production: true,
  backendUrl: 'https://your-backend-domain.com'
};
```

## Spotify App Configuration
1. Create a Spotify app at https://developer.spotify.com/dashboard
2. Add redirect URI: `http://your-backend-domain.com/auth/callback`
3. Note down Client ID and Client Secret

## Deployment Options

### Option 1: Vercel (Frontend) + Render (Backend)
**Frontend (Vercel):**
1. Connect your GitHub repository to Vercel
2. Set build command: `npm run build:prod`
3. Set output directory: `dist/music-guess`
4. Deploy

**Backend (Render):**
1. Connect your GitHub repository to Render
2. Set build command: `cd src/backend && npm install`
3. Set start command: `cd src/backend && npm start`
4. Add environment variables
5. Deploy

### Option 2: Netlify (Frontend) + Railway (Backend)
**Frontend (Netlify):**
1. Connect repository to Netlify
2. Build command: `npm run build:prod`
3. Publish directory: `dist/music-guess`

**Backend (Railway):**
1. Connect repository to Railway
2. Set start command: `cd src/backend && npm start`
3. Add environment variables

### Option 3: Firebase Hosting (Frontend) + Google Cloud Run (Backend)
**Frontend (Firebase):**
1. Install Firebase CLI: `npm install -g firebase-tools`
2. Initialize: `firebase init hosting`
3. Build: `npm run build:prod`
4. Deploy: `firebase deploy`

**Backend (Cloud Run):**
1. Create Dockerfile in src/backend/
2. Deploy to Cloud Run with environment variables

## Local Development
```bash
# Install dependencies
npm install
cd src/backend && npm install

# Start backend
cd src/backend && npm start

# Start frontend (in another terminal)
npm start
```

## Production Build
```bash
# Build frontend for production
npm run build:prod

# The built files will be in dist/music-guess/
```

## Important Notes
- Ensure CORS is properly configured for your domain
- Update Spotify redirect URI to match your production backend URL
- Use HTTPS in production for security
- Consider using a database for session storage in production (currently using in-memory storage)
- Monitor API rate limits for Spotify

## Security Considerations
- Never expose Spotify Client Secret in frontend code
- Use environment variables for all sensitive configuration
- Implement proper session management
- Consider rate limiting for API endpoints

## Troubleshooting
- Check browser console for frontend errors
- Check backend logs for server errors
- Verify Spotify app configuration
- Ensure all environment variables are set correctly
