import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../environments/environment';

export interface SpotifySession {
  sessionId: string;
  userId: string;
  userName: string;
  expiresAt: number;
}

@Injectable({
  providedIn: 'root'
})
export class SpotifyAuthService {
  private readonly BACKEND_URL = this.getBackendUrl();

  // Signals for reactive state management
  isAuthenticated = signal<boolean>(false);
  currentSession = signal<SpotifySession | null>(null);
  isLoading = signal<boolean>(false);

  private getBackendUrl(): string {
    // Check if we're running on localhost (development)
    const isLocalhost = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' ||
                       window.location.hostname === '0.0.0.0';
    
    if (isLocalhost) {
      // Local development - use localhost backend
      return 'http://localhost:3000';
    } else {
      // Any other hostname (deployed frontend) - use production backend
      return 'https://music-guesser-backend-whu4.onrender.com';
    }
  }

  constructor(private http: HttpClient) {
    this.checkExistingSession();
    this.setupSessionPersistence();
  }

  // Check if there's an existing session from URL or localStorage
  private checkExistingSession(): void {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session');
    
    if (sessionId) {
      // Remove session from URL
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
      
      // Verify session with backend
      this.verifySession(sessionId);
    } else {
      // Check localStorage for existing session
      const storedSession = localStorage.getItem('spotify_session');
      if (storedSession) {
        try {
          const session = JSON.parse(storedSession);
          this.verifySession(session.sessionId);
        } catch (error) {
          // Invalid stored session
          localStorage.removeItem('spotify_session');
        }
      }
    }
  }


  // Login with Spotify
  login(): void {
    // Redirecting to Spotify login
    window.location.href = `${this.BACKEND_URL}/auth/login`;
  }

  // Logout
  logout(): void {
    const session = this.currentSession();
    if (session) {
      this.http.post(`${this.BACKEND_URL}/auth/logout/${session.sessionId}`, {}).subscribe({
        next: () => {
          // Logged out successfully
        },
        error: (error) => {
          // Logout error
        }
      });
    }
    
    // Clear local state
    this.currentSession.set(null);
    this.isAuthenticated.set(false);
    localStorage.removeItem('spotify_session');
  }

  // Refresh access token
  refreshToken(): Promise<boolean> {
    return new Promise((resolve) => {
      const session = this.currentSession();
      if (!session) {
        resolve(false);
        return;
      }

      this.http.post<any>(`${this.BACKEND_URL}/auth/refresh/${session.sessionId}`, {}).subscribe({
        next: (response) => {
          if (response.success) {
            // Update session with new expiry
            const updatedSession: SpotifySession = {
              ...session,
              expiresAt: response.expiresAt
            };
            
            this.currentSession.set(updatedSession);
            localStorage.setItem('spotify_session', JSON.stringify(updatedSession));
            
            // Token refreshed successfully
            resolve(true);
          } else {
            // Token refresh failed
            this.logout();
            resolve(false);
          }
        },
        error: (error) => {
          // Token refresh error
          this.logout();
          resolve(false);
        }
      });
    });
  }

  // Get current session ID
  getSessionId(): string | null {
    const session = this.currentSession();
    return session ? session.sessionId : null;
  }

  // Check if session is about to expire (within 5 minutes)
  isSessionExpiringSoon(): boolean {
    const session = this.currentSession();
    if (!session) return false;
    
    const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
    return (session.expiresAt - Date.now()) < fiveMinutes;
  }

  // Test Spotify API access
  testSpotifyAccess(): Promise<any> {
    return new Promise((resolve, reject) => {
      const session = this.currentSession();
      if (!session) {
        reject(new Error('No active session'));
        return;
      }

      this.http.get<any>(`${this.BACKEND_URL}/test-spotify/${session.sessionId}`).subscribe({
        next: (response) => {
          resolve(response);
        },
        error: (error) => {
          reject(error);
        }
      });
    });
  }

  // Setup session persistence
  private setupSessionPersistence(): void {
    // Check for existing session on page load
    const storedSession = localStorage.getItem('spotify_session');
    if (storedSession) {
      try {
        const session = JSON.parse(storedSession);
        // Verify session is still valid
        if (session.expiresAt > Date.now()) {
          this.verifySession(session.sessionId);
        } else {
          // Stored session expired
          localStorage.removeItem('spotify_session');
        }
      } catch (error) {
        // Invalid stored session
        localStorage.removeItem('spotify_session');
      }
    }

    // Auto-refresh token before it expires
    this.setupTokenRefresh();
  }

  // Setup automatic token refresh
  private setupTokenRefresh(): void {
    const session = this.currentSession();
    if (!session) return;

    const timeUntilExpiry = session.expiresAt - Date.now();
    const refreshTime = Math.max(timeUntilExpiry - (5 * 60 * 1000), 0); // Refresh 5 minutes before expiry

    if (refreshTime > 0) {
      // Token will auto-refresh
      
      setTimeout(() => {
        this.refreshToken().then(success => {
          if (success) {
            // Token auto-refreshed successfully
            this.setupTokenRefresh(); // Schedule next refresh
          } else {
            // Auto-refresh failed
          }
        });
      }, refreshTime);
    }
  }

  // Enhanced session verification with better error handling
  private verifySession(sessionId: string): void {
    this.isLoading.set(true);
    
    this.http.get<any>(`${this.BACKEND_URL}/auth/session/${sessionId}`).subscribe({
      next: (response) => {
        if (response.success) {
          const session: SpotifySession = {
            sessionId,
            userId: response.userId,
            userName: response.userName,
            expiresAt: response.expiresAt
          };
          
          this.currentSession.set(session);
          this.isAuthenticated.set(true);
          localStorage.setItem('spotify_session', JSON.stringify(session));
          
          // Session restored from storage
          
          // Setup auto-refresh for restored session
          this.setupTokenRefresh();
        } else {
          // Stored session invalid
          this.logout();
        }
        this.isLoading.set(false);
      },
      error: (error) => {
        // Session verification error
        this.logout();
        this.isLoading.set(false);
      }
    });
  }
}
