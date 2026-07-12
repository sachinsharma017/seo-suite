// CONFIGURATION FOR SEO TOOLS SUITE
const CONFIG = {
    // If running on localhost or directly on your Render server, relative paths ('') work out of the box.
    // If you host the frontend on Netlify, change this URL to your Render backend URL.
    BACKEND_URL: window.location.hostname === 'localhost' || 
                 window.location.hostname === '127.0.0.1' || 
                 window.location.hostname.endsWith('onrender.com')
        ? ''
        : 'https://seo-suite-c1sj.onrender.com' // Your actual Render URL
};
