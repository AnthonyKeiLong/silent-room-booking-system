# Request to IT: Google Workspace sign-in

Please create an OAuth 2.0 **Web application** client for the Silent Booth
Booking System in a school-controlled Google Cloud project/organization.

- Application: Silent Booth Booking System
- Public site: `https://testing.keilong.edu.hk/nodeapp/`
- Authorized redirect URI (exact):
  `https://testing.keilong.edu.hk/nodeapp/api/auth/google/callback`
- Intended users: internal Google Workspace accounts in `keilong.edu.hk`
- Requested scopes: `openid` and `email` only
- No Gmail, Drive, Calendar, Directory or offline access is requested

Please also confirm that the server can make outbound HTTPS connections to
`accounts.google.com`, `oauth2.googleapis.com`, and `www.googleapis.com`.

Please provide the OAuth client ID and client secret through an approved private
channel. The client secret must not be sent in an ordinary chat message or placed
in Nginx. It will be stored only in `/etc/silent-booth-booking.env`, readable by
root and the dedicated `silentbooth` service group.
