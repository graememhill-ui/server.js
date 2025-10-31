import express from "express";
import axios from "axios";
import morgan from "morgan";
import { RateLimiterMemory } from "rate-limiter-flexible";

const app = express();
const PORT = process.env.PORT || 80;

// --- config you can change ---
const TARGET_BASE = process.env.TARGET_BASE || "https://irrocloud.example.com"; 
// e.g. "https://irrocloud.com/iadata" or your exact HTTPS base path
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 5000);
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 10000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const SHARED_KEY = process.env.SHARED_KEY || ""; // set a secret so only you can use the relay
// -----------------------------

app.use(morgan("tiny"));

// Simple IP rate limit (60 req/min)
const limiter = new RateLimiterMemory({ points: 60, duration: 60 });
app.use(async (req, res, next) => {
  try { await limiter.consume(req.ip); next(); }
  catch { res.status(429).send("Too Many Requests"); }
});

// Health check
app.get("/health", (_, res) => res.status(200).send("OK"));

// Only allow requests that include your SHARED_KEY in the path
app.get("/relay/:key/*", async (req, res) => {
  try {
    if (!SHARED_KEY || req.params.key !== SHARED_KEY) {
      return res.status(401).send("Unauthorized");
    }

    // Map the remaining path + query to the HTTPS target
    const tail = req.params[0] || "";
    const query = req.url.includes("?") ? req.url.split("?")[1] : "";
    const url = `${TARGET_BASE.replace(/\/+$/,"")}/${tail}${query ? "?" + query : ""}`;

    // Retry with backoff
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const r = await axios.get(url, {
          timeout: REQ_TIMEOUT_MS,
          transitional: { clarifyTimeoutError: true },
          // Connect timeout “ish”: axios doesn’t separate connect/read timeout,
          // but overall timeout above + quick retry is fine for tiny relay use.
          headers: {
            "User-Agent": "IrroHTTPRelay/1.0"
          },
          validateStatus: () => true, // pass through status
        });
        // mirror status/body (plain text typical for your GET)
        return res.status(r.status).send(r.data);
      } catch (e) {
        lastErr = e;
        // small backoff: 250ms * attempt
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
    console.error("Relay failed:", lastErr?.message || lastErr);
    return res.status(504).send("Gateway Timeout via relay");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Relay error");
  }
});

// reject other methods/paths
app.use((_, res) => res.status(404).send("Not found"));

app.listen(PORT, () => {
  console.log(`HTTP→HTTPS relay listening on :${PORT}`);
});
