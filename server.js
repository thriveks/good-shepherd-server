const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Good Shepherd webhook server is live"
  });
});

app.post("/webhook", (req, res) => {
  try {
    const { sourceName, residentName, message, alertLevel, timeText } = req.body || {};

    if (!sourceName || !residentName || !message || !alertLevel) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: sourceName, residentName, message, alertLevel"
      });
    }

    const event = {
      sourceName: String(sourceName).trim(),
      residentName: String(residentName).trim(),
      message: String(message).trim(),
      alertLevel: String(alertLevel).trim(),
      timeText: String(timeText || "Webhook Event").trim(),
      receivedAt: new Date().toISOString()
    };

    console.log("Webhook event received:");
    console.log(JSON.stringify(event, null, 2));

    return res.status(200).json({
      success: true,
      message: "Webhook event received",
      event
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Good Shepherd webhook server running on http://localhost:${PORT}`);
});