// CONFIGURATION FOR SEO TOOLS SUITE
const CONFIG = {
    // If you run on localhost, the fetch calls will use relative paths ('').
    // When you deploy your backend to Render.com, change this URL to your deployed Render URL.
    // example: 'https://seo-spider-backend.onrender.com'
    BACKEND_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? ''
        : 'https://seo-spider-backend.onrender.com' // Replace with your actual Render URL
};
