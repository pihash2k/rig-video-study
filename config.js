// Where answers go: the Google Apps Script web app (apps_script.gs). serve_local.py ignores this and uses
// its own /api/submit and /api/counts, so local runs never write to the Sheet.
// To deploy, set this to the Apps Script web app URL that ends in /exec (see README.md).
window.STUDY_CONFIG = {
  endpoint: "https://script.google.com/macros/s/AKfycbwaxrSNSqVEc0Uk4gninaBwU6ji0sWvNRUInWASjiN0mGPYVUxGPnj-B0Pqra_35nab/exec",
};
