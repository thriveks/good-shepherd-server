Good Shepherd Server
====================

Purpose
-------
This is the first simple Node/Express webhook server for the Good Shepherd Home Monitoring System.

This server is for proof of concept testing only.

What it does
------------
- accepts webhook POST events
- validates required fields
- logs the event in the terminal
- returns a JSON success response

Expected event payload
----------------------
{
  "sourceName": "Wyze Camera",
  "residentName": "Mary Thompson",
  "message": "Motion detected in monitored area.",
  "alertLevel": "Caution",
  "timeText": "Webhook Event"
}

Required fields
---------------
- sourceName
- residentName
- message
- alertLevel

Files in this folder
--------------------
- server.js
- package.json
- README.txt

How to run
----------
1. Open Terminal in this folder
2. Run:
   npm install
3. Then run:
   npm start

Expected local server URL
-------------------------
http://localhost:3000

Available routes
----------------
GET /
- returns a basic live status response

POST /webhook
- accepts webhook event payloads

Example curl test
-----------------
curl -X POST "http://localhost:3000/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceName": "Wyze Camera",
    "residentName": "Mary Thompson",
    "message": "Motion detected in monitored area.",
    "alertLevel": "Caution",
    "timeText": "Webhook Event"
  }'

Next planned upgrades
---------------------
- persistent storage
- duplicate protection
- processed event states
- authentication
- escalation logic
- production hosting