# Phone System — Technical Implementation Plan

## Twilio Functions, Code Patterns, and Data Models

---

## 1. Twilio SIP Domain Setup

### Domain configuration

```
Domain URI:        yourcompany.sip.us1.twilio.com
Registration:      Enabled
Voice Config URL:  https://{service}.twil.io/outbound-handler
                   (points to outbound-handler Function)
Fallback URL:      https://{service}.twil.io/fallback
Status Callback:   https://{service}.twil.io/call-status
```

### Credential list

Each extension is a credential entry. Created programmatically via admin portal using the Twilio REST API:

```javascript
// Admin portal calls this when creating a new extension
const credential = await twilioClient.sip
  .credentialLists("CL_XXXXXXX")
  .credentials.create({
    username: "101",              // extension number
    password: generateSecurePassword()
  });
```

Username format options:
- `101` — simple extension (for internal SIP-to-SIP calls)
- `+15551234567` — E.164 format (allows Twilio to route inbound calls directly to the correct SIP endpoint by matching the To number)

We use simple extension numbers because our IVR handles inbound routing. E.164 usernames would only matter for direct-inward-dial without IVR.

---

## 2. Twilio Functions — Complete Specification

All Functions are deployed as a single Twilio Serverless Service. They read TwiML XML and config from Azure Blob Storage, and write call logs and voicemail metadata back to blob.

### Environment variables (set in Twilio Serverless console)

```
AZURE_BLOB_BASE_URL    = https://yourcompany.blob.core.windows.net
AZURE_BLOB_SAS_READ    = ?sv=...&sig=... (long-lived read-only SAS for the service)
AZURE_BLOB_SAS_WRITE   = ?sv=...&sig=... (long-lived write SAS, scoped to /logs and /voicemail)
TWILIO_PHONE_NUMBER    = +15559876543
COMPANY_NAME           = Acme Corp
FALLBACK_EXT           = 100
VOICEMAIL_MAX_LENGTH   = 120
RING_TIMEOUT           = 25
```

Note on the service-level SAS tokens: these are long-lived (1 year) tokens used only by the Twilio Functions to read/write blob. They are stored in Twilio's environment variables, not exposed to any client. Rotate annually.

---

### Function 1: `inbound-handler`

**Trigger:** Twilio phone number voice webhook (when someone calls your company number)

**Purpose:** Fetches and serves the main IVR menu TwiML from blob storage.

```javascript
// functions/inbound-handler.js

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  try {
    // Fetch the main menu TwiML from blob
    const blobUrl = `${context.AZURE_BLOB_BASE_URL}/ivr/main-menu.xml${context.AZURE_BLOB_SAS_READ}`;
    const response = await fetch(blobUrl);

    if (!response.ok) {
      throw new Error(`Blob fetch failed: ${response.status}`);
    }

    // Return the raw TwiML XML from blob
    const xmlContent = await response.text();
    callback(null, xmlContent);

  } catch (error) {
    console.error("Inbound handler error:", error);

    // Fallback: apologize and try to connect to operator
    twiml.say(
      { voice: "Polly.Joanna" },
      "We're sorry, we are experiencing technical difficulties. Please try again later."
    );
    twiml.hangup();
    callback(null, twiml);
  }
};
```

**What the blob TwiML looks like** (`/ivr/main-menu.xml`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="8"
         action="https://{service}.twil.io/gather-handler?menu=main">
    <Play>https://yourcompany.blob.core.windows.net/audio/ivr/main-greeting.mp3?{SAS}</Play>
  </Gather>
  <!-- On timeout, replay menu once then go to voicemail -->
  <Redirect>https://{service}.twil.io/gather-handler?menu=main&amp;digit=timeout</Redirect>
</Response>
```

---

### Function 2: `gather-handler`

**Trigger:** Called by `<Gather>` action URL when caller presses a key or timeout occurs.

**Purpose:** The core IVR routing brain. Reads the IVR tree config, determines what to do based on the pressed digit, and returns the appropriate TwiML.

```javascript
// functions/gather-handler.js

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const menuId = event.menu || "main";
  const digit = event.Digits || event.digit || null;
  const retries = parseInt(event.retries || "0");

  try {
    // Fetch the IVR tree config from blob
    const configUrl = `${context.AZURE_BLOB_BASE_URL}/config/ivr-tree.json${context.AZURE_BLOB_SAS_READ}`;
    const configResponse = await fetch(configUrl);
    const ivrTree = await configResponse.json();

    const menu = ivrTree.menus[menuId];
    if (!menu) {
      throw new Error(`Menu not found: ${menuId}`);
    }

    // Handle timeout
    if (digit === "timeout" || digit === null) {
      if (retries >= 2) {
        // After 2 timeouts, go to voicemail or operator
        return handleFallback(context, twiml, menu, ivrTree, callback);
      }
      // Replay the menu
      const menuXmlUrl = `${context.AZURE_BLOB_BASE_URL}/ivr/${menuId}-menu.xml${context.AZURE_BLOB_SAS_READ}`;
      const xmlResponse = await fetch(menuXmlUrl);
      let xml = await xmlResponse.text();
      // Increment retry counter in the gather action URL
      xml = xml.replace(
        `menu=${menuId}`,
        `menu=${menuId}&retries=${retries + 1}`
      );
      return callback(null, xml);
    }

    // Look up what this digit does in this menu
    const option = menu.options[digit];

    if (!option) {
      // Invalid digit — announce and replay
      twiml.say(
        { voice: "Polly.Joanna" },
        "That is not a valid option."
      );
      twiml.redirect(
        `https://${context.DOMAIN_NAME}/gather-handler?menu=${menuId}&retries=${retries}`
      );
      return callback(null, twiml);
    }

    // Route based on action type
    switch (option.action) {

      case "submenu":
        // Fetch and serve the submenu TwiML
        const subMenuUrl = `${context.AZURE_BLOB_BASE_URL}/ivr/${option.target}-menu.xml${context.AZURE_BLOB_SAS_READ}`;
        const subResponse = await fetch(subMenuUrl);
        const subXml = await subResponse.text();
        return callback(null, subXml);

      case "extension":
        // Ring the target extension
        return handleDialExtension(context, twiml, option.target, ivrTree, callback);

      case "ring-group":
        // Ring multiple extensions simultaneously
        return handleRingGroup(context, twiml, option.targets, ivrTree, callback);

      case "voicemail":
        // Go directly to voicemail for target user
        return handleVoicemail(context, twiml, option.target, ivrTree, callback);

      case "forward":
        // Forward to external number
        twiml.dial({ callerId: context.TWILIO_PHONE_NUMBER }, function (dial) {
          dial.number(option.target);
        });
        return callback(null, twiml);

      case "announcement":
        // Play a message and hang up
        const announcementUrl = `${context.AZURE_BLOB_BASE_URL}/audio/ivr/${option.audioFile}${context.AZURE_BLOB_SAS_READ}`;
        twiml.play(announcementUrl);
        twiml.hangup();
        return callback(null, twiml);

      default:
        throw new Error(`Unknown action: ${option.action}`);
    }

  } catch (error) {
    console.error("Gather handler error:", error);
    twiml.say(
      { voice: "Polly.Joanna" },
      "We're sorry, an error occurred. Please try again."
    );
    twiml.hangup();
    callback(null, twiml);
  }
};


// --- Helper functions ---

function handleDialExtension(context, twiml, extensionId, ivrTree, callback) {
  const directory = ivrTree.directory;
  const userId = directory.extensions[extensionId];
  const user = directory.users.find(u => u.userId === userId);

  const dial = twiml.dial({
    callerId: context.TWILIO_PHONE_NUMBER,
    timeout: parseInt(context.RING_TIMEOUT),
    action: `https://${context.DOMAIN_NAME}/dial-status?ext=${extensionId}&userId=${userId}`
  });

  // Ring the SIP endpoint (MicroSIP / Zoiper on desk)
  dial.sip(`sip:${extensionId}@${context.SIP_DOMAIN}`);

  // Simultaneously ring forwarded phone if configured
  // Use whisper URL so agent hears announcement before connecting
  if (user && user.phone) {
    const whisperText = user.whisperText || `Incoming call for extension ${extensionId}`;
    const whisperUrl = `https://${context.DOMAIN_NAME}/whisper?text=${encodeURIComponent(whisperText)}`;
    dial.number({ url: whisperUrl }, user.phone);
  }

  callback(null, twiml);
}

function handleRingGroup(context, twiml, extensions, ivrTree, callback) {
  const dial = twiml.dial({
    callerId: context.TWILIO_PHONE_NUMBER,
    timeout: parseInt(context.RING_TIMEOUT),
    action: `https://${context.DOMAIN_NAME}/dial-status?group=true`
  });

  extensions.forEach(ext => {
    dial.sip(`sip:${ext}@${context.SIP_DOMAIN}`);
  });

  callback(null, twiml);
}

function handleVoicemail(context, twiml, targetUserId, ivrTree, callback) {
  const vmGreetingUrl = `${context.AZURE_BLOB_BASE_URL}/audio/voicemail/${targetUserId}-greeting.mp3${context.AZURE_BLOB_SAS_READ}`;

  // Try user's personal greeting, fall back to generic
  twiml.play(vmGreetingUrl);
  twiml.say(
    { voice: "Polly.Joanna" },
    "Please leave a message after the tone."
  );
  twiml.record({
    maxLength: parseInt(context.VOICEMAIL_MAX_LENGTH),
    action: `https://${context.DOMAIN_NAME}/voicemail-handler?userId=${targetUserId}`,
    transcribe: false,
    playBeep: true
  });

  callback(null, twiml);
}

function handleFallback(context, twiml, menu, ivrTree, callback) {
  if (menu.fallback && menu.fallback.action === "voicemail") {
    return handleVoicemail(context, twiml, menu.fallback.target, ivrTree, callback);
  }
  if (menu.fallback && menu.fallback.action === "extension") {
    return handleDialExtension(context, twiml, menu.fallback.target, ivrTree, callback);
  }
  // Default: hang up with message
  twiml.say({ voice: "Polly.Joanna" }, "Goodbye.");
  twiml.hangup();
  callback(null, twiml);
}
```

---

### Function 3: `outbound-handler`

**Trigger:** SIP Domain voice configuration URL (when a registered SIP phone dials out)

**Purpose:** Determines whether the dialed number is an internal extension or an external PSTN number, and routes accordingly.

```javascript
// functions/outbound-handler.js

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  // event.To contains what the SIP phone dialed
  // Format: sip:DIALED@yourcompany.sip.us1.twilio.com
  const sipTo = event.To || "";
  const dialed = sipTo.replace(/^sip:/, "").split("@")[0];

  // event.From contains the caller's SIP identity
  const sipFrom = event.From || "";
  const callerExt = sipFrom.replace(/^sip:/, "").split("@")[0];

  try {
    // Fetch directory to resolve extensions
    const configUrl = `${context.AZURE_BLOB_BASE_URL}/config/directory.json${context.AZURE_BLOB_SAS_READ}`;
    const configResponse = await fetch(configUrl);
    const directory = await configResponse.json();

    // Determine if this is an internal extension call
    const isExtension = directory.extensions.hasOwnProperty(dialed);

    if (isExtension) {
      // Internal SIP-to-SIP call
      const targetUserId = directory.extensions[dialed];
      const targetUser = directory.users.find(u => u.userId === targetUserId);

      const dial = twiml.dial({
        callerId: callerExt,
        timeout: parseInt(context.RING_TIMEOUT),
        action: `https://${context.DOMAIN_NAME}/dial-status?ext=${dialed}&userId=${targetUserId}&internal=true`
      });

      // Ring SIP endpoint
      dial.sip(`sip:${dialed}@${context.SIP_DOMAIN}`);

      // Also ring forwarded phone if set
      if (targetUser && targetUser.phone) {
        dial.number(targetUser.phone);
      }

    } else {
      // External PSTN call
      let phoneNumber = dialed;

      // Normalize the number
      // Handle 00 or 011 international prefix
      if (phoneNumber.startsWith("011")) {
        phoneNumber = "+" + phoneNumber.substring(3);
      } else if (phoneNumber.startsWith("00")) {
        phoneNumber = "+" + phoneNumber.substring(2);
      } else if (phoneNumber.length === 10) {
        // US 10-digit → E.164
        phoneNumber = "+1" + phoneNumber;
      } else if (phoneNumber.length === 11 && phoneNumber.startsWith("1")) {
        phoneNumber = "+" + phoneNumber;
      } else if (!phoneNumber.startsWith("+")) {
        phoneNumber = "+" + phoneNumber;
      }

      // Look up caller's outbound caller ID
      const callerUserId = directory.extensions[callerExt];
      const callerUser = directory.users.find(u => u.userId === callerUserId);

      // Use company number as caller ID (or user's DID if assigned)
      const callerId = (callerUser && callerUser.did) || context.TWILIO_PHONE_NUMBER;

      twiml.dial({ callerId: callerId }, function (dial) {
        dial.number(phoneNumber);
      });
    }

    // Log the outbound call attempt
    await logCallStart(context, {
      direction: "outbound",
      fromExt: callerExt,
      to: dialed,
      internal: isExtension
    });

    callback(null, twiml);

  } catch (error) {
    console.error("Outbound handler error:", error);
    twiml.say({ voice: "Polly.Joanna" }, "Your call cannot be completed. Please try again.");
    twiml.hangup();
    callback(null, twiml);
  }
};

async function logCallStart(context, data) {
  // Write initial call record to blob (will be updated by call-status)
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const callId = `call-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

  const record = {
    callId: callId,
    timestamp: now.toISOString(),
    direction: data.direction,
    fromExt: data.fromExt,
    to: data.to,
    internal: data.internal,
    status: "initiated",
    duration: 0
  };

  const blobPath = `/logs/${dateStr}/${callId}.json`;
  const putUrl = `${context.AZURE_BLOB_BASE_URL}${blobPath}${context.AZURE_BLOB_SAS_WRITE}`;

  await fetch(putUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-ms-blob-type": "BlockBlob"
    },
    body: JSON.stringify(record)
  });
}
```

---

### Function 4: `dial-status`

**Trigger:** The `action` URL on `<Dial>` — called after a dial attempt completes (answered, no-answer, busy, failed).

**Purpose:** If the call was not answered, route to voicemail. Also update the call log.

```javascript
// functions/dial-status.js

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const dialStatus = event.DialCallStatus;   // completed, no-answer, busy, failed, canceled
  const ext = event.ext;
  const userId = event.userId;
  const isInternal = event.internal === "true";

  if (dialStatus === "completed") {
    // Call was answered and has now ended — just hang up cleanly
    twiml.hangup();
    return callback(null, twiml);
  }

  // Call was NOT answered — route to voicemail
  if (userId && !isInternal) {
    // Check if user has a personal voicemail greeting
    const greetingUrl = `${context.AZURE_BLOB_BASE_URL}/audio/voicemail/${userId}-greeting.mp3${context.AZURE_BLOB_SAS_READ}`;

    try {
      const checkResponse = await fetch(greetingUrl, { method: "HEAD" });
      if (checkResponse.ok) {
        twiml.play(greetingUrl);
      } else {
        twiml.say(
          { voice: "Polly.Joanna" },
          `The person at extension ${ext} is not available.`
        );
      }
    } catch (e) {
      twiml.say(
        { voice: "Polly.Joanna" },
        `The person at extension ${ext} is not available.`
      );
    }

    twiml.say({ voice: "Polly.Joanna" }, "Please leave a message after the tone.");
    twiml.record({
      maxLength: parseInt(context.VOICEMAIL_MAX_LENGTH),
      action: `https://${context.DOMAIN_NAME}/voicemail-handler?userId=${userId}&ext=${ext}`,
      playBeep: true
    });
  } else {
    // Internal call or no user found — just announce unavailable
    twiml.say({ voice: "Polly.Joanna" }, `Extension ${ext} is not available.`);
    twiml.hangup();
  }

  callback(null, twiml);
};
```

---

### Function 5: `voicemail-handler`

**Trigger:** Called after `<Record>` completes — Twilio POSTs the recording URL.

**Purpose:** Writes voicemail metadata to blob and optionally triggers email notification.

```javascript
// functions/voicemail-handler.js

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  const userId = event.userId;
  const ext = event.ext || "unknown";
  const recordingUrl = event.RecordingUrl;         // Twilio-hosted recording URL
  const recordingSid = event.RecordingSid;
  const recordingDuration = parseInt(event.RecordingDuration || "0");
  const callerNumber = event.From || "unknown";

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");

  try {
    // Download the recording from Twilio and store in our blob
    const audioResponse = await fetch(`${recordingUrl}.mp3`);
    const audioBuffer = await audioResponse.buffer();

    const audioBlobPath = `/voicemail/${userId}/${timestamp}.mp3`;
    const audioPutUrl = `${context.AZURE_BLOB_BASE_URL}${audioBlobPath}${context.AZURE_BLOB_SAS_WRITE}`;

    await fetch(audioPutUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "audio/mpeg",
        "x-ms-blob-type": "BlockBlob"
      },
      body: audioBuffer
    });

    // Write metadata JSON alongside the audio
    const metadata = {
      voicemailId: `vm-${recordingSid}`,
      userId: userId,
      extensionAtTime: ext,
      callerNumber: callerNumber,
      timestamp: now.toISOString(),
      duration: recordingDuration,
      audioFile: `${timestamp}.mp3`,
      audioPath: audioBlobPath,
      twilioRecordingSid: recordingSid,
      listened: false,
      forwardedToEmail: false
    };

    const metaBlobPath = `/voicemail/${userId}/${timestamp}.json`;
    const metaPutUrl = `${context.AZURE_BLOB_BASE_URL}${metaBlobPath}${context.AZURE_BLOB_SAS_WRITE}`;

    await fetch(metaPutUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-ms-blob-type": "BlockBlob"
      },
      body: JSON.stringify(metadata)
    });

    // Check if user wants email notification
    const dirUrl = `${context.AZURE_BLOB_BASE_URL}/config/directory.json${context.AZURE_BLOB_SAS_READ}`;
    const dirResponse = await fetch(dirUrl);
    const directory = await dirResponse.json();
    const user = directory.users.find(u => u.userId === userId);

    if (user && user.emailVoicemail && user.email) {
      // Trigger email notification
      // Uses Twilio SendGrid or a simple webhook to your server
      await triggerEmailNotification(context, user, metadata);
    }

    // Delete the recording from Twilio (we have our own copy now)
    const twilioClient = context.getTwilioClient();
    await twilioClient.recordings(recordingSid).remove();

  } catch (error) {
    console.error("Voicemail handler error:", error);
  }

  // Thank the caller
  twiml.say({ voice: "Polly.Joanna" }, "Your message has been recorded. Goodbye.");
  twiml.hangup();
  callback(null, twiml);
};

async function triggerEmailNotification(context, user, metadata) {
  // Uses Twilio SendGrid (free tier: 100 emails/day)
  // SendGrid API key stored in SENDGRID_API_SECRET env var
  
  // Step 1: Optionally transcribe via OpenAI Whisper
  let transcript = null;
  if (user.transcribeVoicemail) {
    const audioUrl = `${context.AZURE_BLOB_BASE_URL}${metadata.audioPath}${context.AZURE_BLOB_SAS_READ}`;
    const audioResp = await fetch(audioUrl);
    const audioBuffer = await audioResp.buffer();
    
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'voicemail.mp3');
    formData.append('model', 'whisper-1');
    
    const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${context.OPENAI_API_KEY}` },
      body: formData
    });
    const whisperResult = await whisperResp.json();
    transcript = whisperResult.text;
  }

  // Step 2: Send email via SendGrid
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(context.SENDGRID_API_SECRET);

  const audioUrl = `${context.AZURE_BLOB_BASE_URL}${metadata.audioPath}${context.AZURE_BLOB_SAS_READ}`;
  const audioResp = await fetch(audioUrl);
  const audioBase64 = (await audioResp.buffer()).toString('base64');

  await sgMail.send({
    to: user.email,
    from: context.FROM_EMAIL_ADDRESS,
    subject: `Voicemail from ${metadata.callerNumber} (${metadata.duration}s)`,
    html: `
      <p>You have a new voicemail on extension ${metadata.extensionAtTime}.</p>
      <p><strong>From:</strong> ${metadata.callerNumber}<br>
      <strong>Duration:</strong> ${metadata.duration} seconds<br>
      <strong>Time:</strong> ${metadata.timestamp}</p>
      ${transcript ? `<p><strong>Transcript:</strong> ${transcript}</p>` : ''}
      <p>Listen in the <a href="${context.PORTAL_URL}">UniSip portal</a>.</p>
    `,
    attachments: [{
      content: audioBase64,
      filename: 'voicemail.mp3',
      type: 'audio/mpeg',
      disposition: 'attachment'
    }]
  });
}
```

---

### Function 6: `call-status`

**Trigger:** Status callback URL on the Twilio phone number and SIP domain. Called as call progresses through states.

**Purpose:** Writes/updates the complete call detail record in blob.

```javascript
// functions/call-status.js

exports.handler = async function (context, event, callback) {
  // Twilio sends status callbacks at various stages:
  // initiated, ringing, in-progress, completed, busy, no-answer, failed, canceled

  const callSid = event.CallSid;
  const callStatus = event.CallStatus;
  const direction = event.Direction;           // inbound or outbound-dial
  const from = event.From || "";
  const to = event.To || "";
  const duration = parseInt(event.CallDuration || "0");
  const timestamp = event.Timestamp || new Date().toISOString();

  // Only write final record on terminal states
  const terminalStates = ["completed", "busy", "no-answer", "failed", "canceled"];
  if (!terminalStates.includes(callStatus)) {
    return callback(null, "");
  }

  try {
    // Resolve extension and userId
    const dirUrl = `${context.AZURE_BLOB_BASE_URL}/config/directory.json${context.AZURE_BLOB_SAS_READ}`;
    const dirResponse = await fetch(dirUrl);
    const directory = await dirResponse.json();

    let extensionAtTime = null;
    let userId = null;

    // For inbound: To is the Twilio number, we need to find which ext answered
    // For outbound: From is the SIP URI, extract extension
    if (direction === "outbound-dial" || direction === "outbound-api") {
      const fromExt = from.replace(/^sip:/, "").split("@")[0];
      extensionAtTime = fromExt;
      userId = directory.extensions[fromExt] || null;
    } else {
      // Inbound — check the SipCallId or Called SIP header
      // The ext info comes from our gather-handler passing it through
      extensionAtTime = event.ext || null;
      if (extensionAtTime) {
        userId = directory.extensions[extensionAtTime] || null;
      }
    }

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];

    const record = {
      callId: callSid,
      timestamp: now.toISOString(),
      direction: direction === "inbound" ? "inbound" : "outbound",
      from: from,
      to: to,
      extensionAtTime: extensionAtTime,
      userId: userId,
      duration: duration,
      status: callStatus,
      recordingUrl: null,
      voicemailId: null
    };

    // Write to blob
    const blobPath = `/logs/${dateStr}/${callSid}.json`;
    const putUrl = `${context.AZURE_BLOB_BASE_URL}${blobPath}${context.AZURE_BLOB_SAS_WRITE}`;

    await fetch(putUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-ms-blob-type": "BlockBlob"
      },
      body: JSON.stringify(record)
    });

  } catch (error) {
    console.error("Call status handler error:", error);
  }

  callback(null, "");
};
```

---

### Function 7: `fallback`

**Trigger:** Any Twilio webhook failure (primary URL times out or returns invalid TwiML)

**Purpose:** Graceful degradation — apologize and try to connect to the operator extension.

```javascript
// functions/fallback.js

exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "Polly.Joanna" },
    "We apologize for the inconvenience. Please hold while we connect you to an operator."
  );

  const dial = twiml.dial({
    callerId: context.TWILIO_PHONE_NUMBER,
    timeout: 30
  });
  dial.sip(`sip:${context.FALLBACK_EXT}@${context.SIP_DOMAIN}`);

  // If operator doesn't answer either
  twiml.say(
    { voice: "Polly.Joanna" },
    "No one is available at this time. Please try again later. Goodbye."
  );
  twiml.hangup();

  callback(null, twiml);
};
```

---

## 3. Complete Data Models

### 3.1 IVR Tree (`/config/ivr-tree.json`)

The master configuration that drives the entire IVR behavior.

```json
{
  "version": 3,
  "lastModified": "2026-05-18T10:00:00Z",
  "modifiedBy": "admin@company.com",
  "defaultVoice": "alloy",
  "defaultLanguage": "en",

  "menus": {
    "main": {
      "id": "main",
      "label": "Main menu",
      "greetingText": "Thank you for calling Acme Corp. Press 1 for sales, press 2 for support, or press 0 to speak with an operator.",
      "greetingAudio": "/audio/ivr/main-greeting.mp3",
      "options": {
        "1": { "action": "submenu", "target": "sales", "label": "Sales" },
        "2": { "action": "submenu", "target": "support", "label": "Support" },
        "0": { "action": "extension", "target": "100", "label": "Operator" },
        "9": { "action": "submenu", "target": "directory", "label": "Dial by extension" }
      },
      "fallback": {
        "action": "voicemail",
        "target": "usr-operator",
        "afterRetries": 2
      }
    },

    "sales": {
      "id": "sales",
      "label": "Sales department",
      "greetingText": "You've reached the sales department. Press 1 for new accounts, press 2 for existing accounts, or press 0 to return to the main menu.",
      "greetingAudio": "/audio/ivr/sales-greeting.mp3",
      "options": {
        "1": {
          "action": "ring-group",
          "targets": ["101", "102"],
          "label": "Catskills / summer",
          "phone": "+15551234567",
          "whisper": "Incoming call from Catskills sales line",
          "fallback": { "action": "voicemail", "target": "usr-sales-team" }
        },
        "2": {
          "action": "extension",
          "target": "103",
          "label": "National sales",
          "whisper": "National sales call",
          "fallback": { "action": "voicemail", "target": "usr-sales-team" }
        },
        "3": {
          "action": "forward",
          "target": "+17185550199",
          "label": "Customer support",
          "whisper": "Customer support call forwarded from main line",
          "fallback": { "action": "voicemail", "target": "usr-support-team" }
        },
        "0": { "action": "submenu", "target": "main", "label": "Main menu" }
      },
      "fallback": {
        "action": "voicemail",
        "target": "usr-sales-team",
        "afterRetries": 2
      }
    },

    "support": {
      "id": "support",
      "label": "Support department",
      "greetingText": "You've reached support. Press 1 for technical support, press 2 for billing, or press 0 to return to the main menu.",
      "greetingAudio": "/audio/ivr/support-greeting.mp3",
      "options": {
        "1": { "action": "extension", "target": "201", "label": "Technical support" },
        "2": { "action": "extension", "target": "202", "label": "Billing" },
        "0": { "action": "submenu", "target": "main", "label": "Main menu" }
      },
      "fallback": {
        "action": "voicemail",
        "target": "usr-support-team",
        "afterRetries": 2
      }
    },

    "directory": {
      "id": "directory",
      "label": "Dial by extension",
      "greetingText": "Please enter the extension number you'd like to reach, followed by the pound sign.",
      "greetingAudio": "/audio/ivr/directory-greeting.mp3",
      "inputMode": "extension-direct-dial",
      "options": {},
      "fallback": {
        "action": "submenu",
        "target": "main",
        "afterRetries": 2
      }
    }
  }
}
```

---

### 3.2 Company Directory (`/config/directory.json`)

The source of truth for users, extensions, and their mappings.

```json
{
  "version": 12,
  "lastModified": "2026-05-18T10:00:00Z",

  "users": [
    {
      "userId": "usr-001",
      "name": "Alice Smith",
      "email": "alice@company.com",
      "role": "user",
      "status": "active",
      "currentExt": "101",
      "phone": "+15551234567",
      "emailVoicemail": true,
      "transcribeVoicemail": true,
      "whisperText": "Incoming call from sales line",
      "did": null,
      "department": "sales",
      "createdAt": "2025-01-15T00:00:00Z",
      "extensionHistory": [
        { "ext": "105", "from": "2025-01-15", "to": "2025-06-01" },
        { "ext": "101", "from": "2025-06-01", "to": null }
      ]
    },
    {
      "userId": "usr-002",
      "name": "Bob Johnson",
      "email": "bob@company.com",
      "role": "user",
      "status": "active",
      "currentExt": "102",
      "phone": "+15559876543",
      "emailVoicemail": false,
      "did": null,
      "department": "sales",
      "createdAt": "2025-03-10T00:00:00Z",
      "extensionHistory": [
        { "ext": "102", "from": "2025-03-10", "to": null }
      ]
    },
    {
      "userId": "usr-003",
      "name": "Carol Davis",
      "email": "carol@company.com",
      "role": "admin",
      "status": "active",
      "currentExt": "100",
      "phone": "+15555555555",
      "emailVoicemail": true,
      "did": "+15559876543",
      "department": "operations",
      "createdAt": "2024-11-01T00:00:00Z",
      "extensionHistory": [
        { "ext": "100", "from": "2024-11-01", "to": null }
      ]
    },
    {
      "userId": "usr-old-dave",
      "name": "Dave Wilson",
      "email": "dave@company.com",
      "role": "user",
      "status": "inactive",
      "currentExt": null,
      "phone": null,
      "emailVoicemail": false,
      "did": null,
      "department": "sales",
      "createdAt": "2024-06-01T00:00:00Z",
      "deactivatedAt": "2026-02-15T00:00:00Z",
      "extensionHistory": [
        { "ext": "101", "from": "2024-06-01", "to": "2025-01-14" }
      ]
    }
  ],

  "extensions": {
    "100": "usr-003",
    "101": "usr-001",
    "102": "usr-002",
    "201": "usr-005",
    "202": "usr-006"
  },

  "ringGroups": {
    "sales-team": {
      "label": "Sales team",
      "extensions": ["101", "102", "103"],
      "voicemailUserId": "usr-sales-team"
    },
    "support-team": {
      "label": "Support team",
      "extensions": ["201", "202"],
      "voicemailUserId": "usr-support-team"
    }
  },

  "sharedVoicemailBoxes": {
    "usr-operator": { "label": "General / Operator", "notifyEmails": ["office@company.com"] },
    "usr-sales-team": { "label": "Sales team", "notifyEmails": ["sales@company.com"] },
    "usr-support-team": { "label": "Support team", "notifyEmails": ["support@company.com"] }
  }
}
```

---

### 3.3 Call Detail Record (`/logs/{date}/{callSid}.json`)

```json
{
  "callId": "CA1234567890abcdef",
  "timestamp": "2026-05-18T14:30:00Z",
  "direction": "inbound",
  "from": "+15551234567",
  "to": "+15559876543",
  "extensionAtTime": "101",
  "userId": "usr-001",
  "duration": 145,
  "status": "completed",
  "ivrPath": ["main", "sales", "ext-101"],
  "recordingUrl": null,
  "voicemailId": null,
  "internal": false,
  "callerIdName": null
}
```

**Status values:** `completed`, `busy`, `no-answer`, `failed`, `canceled`

**Direction values:** `inbound`, `outbound`

---

### 3.4 Voicemail Record (`/voicemail/{userId}/{timestamp}.json`)

Stored alongside the `.mp3` file with the same name stem.

```json
{
  "voicemailId": "vm-RE1234567890",
  "userId": "usr-001",
  "extensionAtTime": "101",
  "callerNumber": "+15551234567",
  "callerName": null,
  "timestamp": "2026-05-18T14:35:00Z",
  "duration": 32,
  "audioFile": "2026-05-18T143500.mp3",
  "audioPath": "/voicemail/usr-001/2026-05-18T143500.mp3",
  "twilioRecordingSid": "RE1234567890",
  "listened": false,
  "listenedAt": null,
  "forwardedToEmail": true,
  "forwardedAt": "2026-05-18T14:35:05Z",
  "deleted": false
}
```

---

### 3.5 Session Record (`/sessions/{sessionId}.json`)

```json
{
  "sessionId": "sess-a1b2c3d4e5",
  "userId": "usr-001",
  "extensionAtLogin": "101",
  "loginMethod": "otp-extension",
  "createdAt": "2026-05-18T10:00:00Z",
  "expiresAt": "2026-05-18T18:00:00Z",
  "lastRefresh": "2026-05-18T14:30:00Z",
  "active": true,
  "sasScope": "read",
  "sasExpiry": "2026-05-18T15:00:00Z"
}
```

---

### 3.6 Company Settings (`/config/company-settings.json`)

```json
{
  "companyName": "Acme Corp",
  "timezone": "America/New_York",
  "tts": {
    "provider": "openai",
    "voice": "alloy",
    "model": "tts-1",
    "format": "mp3",
    "speed": 1.0
  },
  "voicemail": {
    "maxLengthSeconds": 120,
    "defaultGreetingText": "The person you are trying to reach is not available. Please leave a message after the tone.",
    "transcriptionEnabled": false
  },
  "ivr": {
    "ringTimeoutSeconds": 25,
    "maxRetries": 2,
    "invalidOptionMessage": "That is not a valid option.",
    "timeoutMessage": "We didn't receive your selection."
  },
  "callerIdPolicy": {
    "outbound": "company-number",
    "companyNumber": "+15559876543"
  },
  "businessHours": {
    "enabled": false,
    "timezone": "America/New_York",
    "schedule": {
      "monday":    { "open": "08:00", "close": "18:00" },
      "tuesday":   { "open": "08:00", "close": "18:00" },
      "wednesday": { "open": "08:00", "close": "18:00" },
      "thursday":  { "open": "08:00", "close": "18:00" },
      "friday":    { "open": "08:00", "close": "17:00" },
      "saturday":  null,
      "sunday":    null
    },
    "afterHoursMenu": "after-hours",
    "afterHoursGreeting": "/audio/ivr/after-hours-greeting.mp3"
  }
}
```

---

## 4. Blob Storage Layout (Complete)

```
storage-account/
│
├── config/
│   ├── directory.json            ← user/extension directory
│   ├── ivr-tree.json             ← IVR menu structure
│   └── company-settings.json     ← global settings
│
├── ivr/
│   ├── main-menu.xml             ← TwiML for main menu
│   ├── sales-menu.xml            ← TwiML for sales submenu
│   ├── support-menu.xml          ← TwiML for support submenu
│   ├── directory-menu.xml        ← TwiML for dial-by-extension
│   └── after-hours-menu.xml      ← TwiML for after-hours
│
├── audio/
│   ├── ivr/
│   │   ├── main-greeting.mp3     ← generated by OpenAI TTS
│   │   ├── sales-greeting.mp3
│   │   ├── support-greeting.mp3
│   │   ├── directory-greeting.mp3
│   │   └── after-hours-greeting.mp3
│   ├── voicemail/
│   │   ├── usr-001-greeting.mp3  ← personal VM greetings
│   │   ├── usr-002-greeting.mp3
│   │   └── ...
│   └── system/
│       ├── invalid-option.mp3
│       ├── goodbye.mp3
│       └── default-vm-greeting.mp3
│
├── voicemail/
│   ├── usr-001/
│   │   ├── 2026-05-18T143500.mp3
│   │   ├── 2026-05-18T143500.json
│   │   ├── 2026-05-17T091200.mp3
│   │   ├── 2026-05-17T091200.json
│   │   └── ...
│   ├── usr-002/
│   │   └── ...
│   ├── usr-sales-team/           ← shared voicemail box
│   │   └── ...
│   └── usr-support-team/
│       └── ...
│
├── logs/
│   ├── 2026-05-18/
│   │   ├── CA1234567890.json
│   │   ├── CA0987654321.json
│   │   └── ...
│   ├── 2026-05-17/
│   │   └── ...
│   └── ...
│
└── sessions/
    ├── sess-a1b2c3d4e5.json
    └── ...
```

---

## 5. TwiML XML Templates

These are generated by the admin portal when saving IVR menu changes. The portal builds the XML from the IVR tree config and writes it to blob.

### Main menu

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="8"
         action="https://{service}.twil.io/gather-handler?menu=main">
    <Play>https://{blob}/audio/ivr/main-greeting.mp3?{SAS}</Play>
  </Gather>
  <Redirect>https://{service}.twil.io/gather-handler?menu=main&amp;digit=timeout</Redirect>
</Response>
```

### Submenu (e.g. sales)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="8"
         action="https://{service}.twil.io/gather-handler?menu=sales">
    <Play>https://{blob}/audio/ivr/sales-greeting.mp3?{SAS}</Play>
  </Gather>
  <Redirect>https://{service}.twil.io/gather-handler?menu=sales&amp;digit=timeout</Redirect>
</Response>
```

### Direct extension dial

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="3" timeout="10" finishOnKey="#"
         action="https://{service}.twil.io/extension-direct-dial">
    <Play>https://{blob}/audio/ivr/directory-greeting.mp3?{SAS}</Play>
  </Gather>
  <Redirect>https://{service}.twil.io/gather-handler?menu=main&amp;digit=timeout</Redirect>
</Response>
```

---

## 6. Function Dependency Map

```
Caller dials company number
  │
  ▼
inbound-handler
  │ fetches /ivr/main-menu.xml from blob
  │ returns TwiML with <Gather> pointing to gather-handler
  │
  ▼
gather-handler  ◄── caller presses digit
  │ reads /config/ivr-tree.json
  │ routes based on action type:
  │
  ├── action: submenu     → fetches /ivr/{target}-menu.xml → returns to caller
  ├── action: extension   → builds <Dial><Sip> TwiML → rings the extension
  ├── action: ring-group  → builds <Dial> with multiple <Sip> → rings all
  ├── action: voicemail   → plays greeting → <Record> → voicemail-handler
  ├── action: forward     → builds <Dial><Number> → connects PSTN
  └── action: announcement → plays audio → hangup
  │
  ▼ (if extension/ring-group selected)
dial-status  ◄── called after <Dial> completes
  │ if no-answer/busy → routes to voicemail-handler
  │ if completed → clean hangup
  │
  ▼ (if voicemail recorded)
voicemail-handler  ◄── called after <Record> completes
  │ downloads recording from Twilio
  │ writes .mp3 + .json to /voicemail/{userId}/ in blob
  │ triggers email notification if configured
  │ deletes recording from Twilio (we have our copy)
  │
  ▼ (on all terminal call states)
call-status  ◄── status callback on every call
  │ writes final CDR to /logs/{date}/{callSid}.json

SIP phone dials out
  │
  ▼
outbound-handler
  │ reads /config/directory.json
  │ determines internal extension vs external PSTN
  │ routes accordingly
  │ writes initial call log entry
```

---

## 7. Twilio Serverless Service Structure

```
twilio-serverless-project/
├── .env                          ← environment variables (local dev)
├── package.json
├── functions/
│   ├── inbound-handler.js        ← phone number voice webhook
│   ├── gather-handler.js         ← IVR digit routing brain
│   ├── outbound-handler.js       ← SIP Domain voice URL
│   ├── dial-status.js            ← <Dial> action handler
│   ├── voicemail-handler.js      ← <Record> completion handler
│   ├── call-status.js            ← status callback (CDR writer)
│   ├── fallback.js               ← error fallback handler
│   ├── extension-direct-dial.js  ← dial-by-extension handler
│   └── whisper.js                ← whisper announcement for forwarded calls
└── assets/
    └── (empty — all audio served from Azure Blob)
```

### Whisper function

```javascript
// functions/whisper.js
// Called via the `url` attribute on <Number> inside <Dial>
// Plays a short announcement to the agent BEFORE connecting the caller

exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const text = event.text || "Incoming forwarded call";

  twiml.say({ voice: "Polly.Joanna" }, text);
  // After the whisper, TwiML returns empty — Twilio connects the call

  callback(null, twiml);
};
```

### Environment variables (updated)

```
AZURE_BLOB_BASE_URL    = https://yourcompany.blob.core.windows.net
AZURE_BLOB_SAS_READ    = ?sv=...&sig=...
AZURE_BLOB_SAS_WRITE   = ?sv=...&sig=...
TWILIO_PHONE_NUMBER    = +15559876543
COMPANY_NAME           = UniSip
FALLBACK_EXT           = 100
VOICEMAIL_MAX_LENGTH   = 120
RING_TIMEOUT           = 25
SENDGRID_API_SECRET    = SG.xxxxx (SendGrid API key for voicemail emails)
FROM_EMAIL_ADDRESS     = noreply@unisipbrands.com
OPENAI_API_KEY         = sk-xxxxx (for Whisper transcription in voicemail-handler)
PORTAL_URL             = https://portal.unisipbrands.com
```

### Dependencies (package.json)

```json
{
  "dependencies": {
    "@sendgrid/mail": "^7.7.0"
  }
}
```

### Deployment

```bash
# Install Twilio CLI and Serverless plugin
npm install -g twilio-cli
twilio plugins:install @twilio-labs/plugin-serverless

# Deploy
cd twilio-serverless-project
twilio serverless:deploy --service-name yourcompany-pbx
```

---

## 8. Error Handling Strategy

| Failure | What happens | User experience |
|---|---|---|
| Blob fetch fails (IVR XML) | `inbound-handler` catches error, returns apology TwiML | Caller hears "technical difficulties" message |
| Blob fetch fails (config) | `gather-handler` catches error, redirects to fallback | Caller connected to operator |
| Invalid digit pressed | `gather-handler` announces invalid, replays menu | Caller hears "not a valid option" |
| Extension doesn't answer | `dial-status` routes to voicemail | Caller leaves message |
| Voicemail write fails | `voicemail-handler` logs error, still thanks caller | Caller hears goodbye (message may be lost) |
| Call log write fails | `call-status` logs error silently | No user impact (log gap) |
| All Functions down | Twilio hits fallback URL | Caller hears apology + operator attempt |
| SIP registration down | Calls go to no-answer path → voicemail | Caller leaves message |

---

## 9. Greeting Tabs and Scheduling

### Greeting model (separate from menu options)

Greeting tabs control only the intro text — what callers hear first. Menu options underneath are shared across all greetings. The IVR tree config stores greetings separately:

```json
{
  "greetings": [
    {
      "id": "main",
      "label": "Main (business hours)",
      "text": "Thank you for calling UniSip...",
      "audioFile": "/audio/ivr/greeting-main.mp3",
      "schedule": { "type": "auto", "rule": "businessHours" }
    },
    {
      "id": "after-hours",
      "label": "After hours",
      "text": "You have reached us after regular business hours...",
      "audioFile": "/audio/ivr/greeting-after.mp3",
      "schedule": { "type": "auto", "rule": "outsideBusinessHours" }
    },
    {
      "id": "yomtov-shavuos",
      "label": "Yom Tov — Shavuos",
      "text": "Our offices are currently closed in observance of Shavuos...",
      "audioFile": "/audio/ivr/greeting-shavuos.mp3",
      "schedule": {
        "type": "custom",
        "startNow": false,
        "start": "2026-06-01T00:00:00Z",
        "end": "2026-06-04T18:00:00Z"
      }
    }
  ],
  "onHoldMessage": {
    "text": "Thank you for calling UniSip. While you hold...",
    "audioFile": "/audio/ivr/on-hold.mp3"
  }
}
```

### Greeting resolution at call time

The `inbound-handler` Function resolves which greeting to play:

1. Check for active custom-scheduled greetings (start ≤ now ≤ end, or startNow=true and not expired)
2. If found, use that greeting
3. If not, check business hours schedule
4. If within hours, use main greeting; otherwise use after-hours greeting
5. After the greeting audio, append auto-generated "press X for Y" from menu options

### Auto-generated menu prompt

The system generates the "press X for Y" portion from the options list. The TTS text for a complete greeting is:

```
{greeting.text}

Press 1 for {options[0].label}, press 2 for {options[1].label}, ... or stay on the line for the operator.
```

This is generated at save time and baked into the TTS audio file. Options are auto-numbered — admin only provides labels.

### On hold message

Separate from IVR greetings. Played via `<Play>` inside `<Dial>` when a caller is waiting for someone to answer. Not part of the greeting tab system.

---

## 10. Phone-Primary User Model

### User types

Every user has a phone number. Extensions are optional.

| User type | Phone | Extension | SIP Client | Outbound | Login method |
|---|---|---|---|---|---|
| Forward-only | ✅ required | ❌ none | ❌ none | ❌ cannot | Phone + SMS OTP |
| Extension user | ✅ required | ✅ assigned | ✅ MicroSIP/Zoiper | ✅ can dial out | Ext + voice OTP |
| Admin | ✅ required | ✅ optional | ✅ optional | ✅ if ext | Microsoft Entra |

### Voice call OTP (extension login)

When a user logs in via extension:

1. Server receives `POST /api/auth/request` with `{ type: "ext", value: "101" }`
2. Server looks up ext 101 in directory → finds user
3. Server calls Twilio API to place a call to `sip:101@yourcompany.sip.us1.twilio.com`
4. The call plays a TwiML `<Say>` with a 6-digit OTP: "Your verification code is: 4. 8. 2. 9. 1. 7."
5. The user's MicroSIP/Zoiper rings, they pick up, hear the code
6. They type the code into the portal login screen
7. Server verifies → issues JWT + SAS token

No SMS involved. The SIP client IS the second factor.

### SMS OTP (phone login)

When a user logs in via phone number:

1. Server receives `POST /api/auth/request` with `{ type: "phone", value: "+15551234567" }`
2. Server looks up that phone in directory → finds user
3. Server sends OTP via Twilio Verify to that phone number
4. User receives SMS, types code
5. Server verifies → issues JWT + SAS token

### Routing behavior per user type

For **extension users** with a phone number, the IVR `<Dial>` rings both simultaneously:

```xml
<Dial>
  <Sip>sip:101@yourcompany.sip.us1.twilio.com</Sip>
  <Number url="/whisper?text=...">+15551234567</Number>
</Dial>
```

For **forward-only users**, the IVR `<Dial>` goes directly to their phone:

```xml
<Dial>
  <Number url="/whisper?text=...">+15551234567</Number>
</Dial>
```

### Outbound calling

Only extension users can make outbound calls. The `outbound-handler` Function checks the SIP credential against the directory and verifies `canCallOut: true` before routing to PSTN.

---

## 11. Ring Groups

### Implementation

A ring group rings multiple destinations simultaneously. Implemented as a `<Dial>` with multiple child elements — mix of `<Sip>` (extensions) and `<Number>` (phone numbers):

```xml
<Dial callerId="+15559876543" timeout="25"
      action="/dial-status?group=sales-team">
  <Sip>sip:101@yourcompany.sip.us1.twilio.com</Sip>
  <Sip>sip:102@yourcompany.sip.us1.twilio.com</Sip>
  <Number url="/whisper?text=Sales call">+15551234567</Number>
</Dial>
```

First to answer gets the call. All other endpoints stop ringing. If no one answers within the timeout, the fallback chain activates (forward → voicemail, etc.).

### Fallback chains

Each IVR option stores an ordered list of fallback steps:

```json
{
  "action": "ring-group",
  "targets": ["101", "102"],
  "fallbacks": [
    { "type": "Forward to number", "target": "+15559990000" },
    { "type": "Forward to number", "target": "+15558880000" },
    { "type": "Voicemail", "target": "" }
  ]
}
```

The `dial-status` Function processes fallbacks sequentially — on no-answer, tries the next step. Multiple forward numbers can be chained before reaching voicemail.

---

## 12. Conference Calling

Conference calling is between extension users only — handled entirely by the SIP client (MicroSIP / Zoiper). No additional Twilio Functions or IVR changes required.

### How it works

1. User A (ext 101) is on a call with User B (ext 102)
2. User A presses "Hold" on their SIP client
3. User A dials ext 103
4. User A presses "Conference" or "Merge" on their SIP client
5. Twilio handles the media mixing — all three hear each other
6. Additional participants can be added the same way

This is standard SIP behavior. Twilio's SIP infrastructure supports it natively when the SIP client sends the appropriate conference/merge SIP headers.

---

## 13. Cost Dashboard API

### Data sources

The `GET /api/costs` endpoint aggregates costs from three sources:

**Twilio** — via `GET /2010-04-01/Accounts/{AccountSid}/Usage/Records/ThisMonth.json`:
- Phone number leases
- Inbound call minutes
- Outbound call minutes
- SIP-to-SIP (internal) minutes
- Recording minutes (voicemail)
- Twilio Verify verifications
- SendGrid emails (free tier)

**Azure** — via Azure Cost Management REST API or Azure Consumption API:
- Blob Storage capacity + operations
- Container App vCPU-seconds and GiB-seconds (usually $0 — free tier)
- Static Web Apps (free tier)
- Bandwidth egress

**OpenAI** — tracked by the server in `/config/cost-log.json`:
- TTS generations: character count × rate
- Whisper transcriptions: audio minutes × rate
- Each API call logged with timestamp, character/minute count, and cost

### Response format

```json
{
  "month": "2026-05",
  "total": 34.72,
  "twilio": {
    "subtotal": 25.73,
    "items": [
      { "category": "Phone numbers", "quantity": 2, "unit": "numbers", "rate": 1.00, "cost": 2.00 },
      { "category": "Inbound calls", "quantity": 1247, "unit": "minutes", "rate": 0.0085, "cost": 10.60 }
    ]
  },
  "azure": {
    "subtotal": 2.18,
    "items": [
      { "category": "Blob Storage", "usage": "2.4 GB", "tier": "Pay-as-you-go", "cost": 2.18 },
      { "category": "Container App", "usage": "4200 vCPU-sec", "tier": "Free tier", "cost": 0.00 }
    ]
  },
  "openai": {
    "subtotal": 0.33,
    "items": [
      { "category": "TTS (greetings)", "usage": "4520 chars", "rate": "15/1M chars", "cost": 0.07 },
      { "category": "Whisper (VM)", "usage": "44 min", "rate": "0.006/min", "cost": 0.26 }
    ]
  }
}
```

---

## 14. TTS Preview Workflow

### Per-message preview

Every editable text in the IVR editor (greeting, submenu intro, voicemail greeting, announcement, whisper) has a Preview button. Flow:

1. Admin clicks "Preview" next to a text field
2. SPA calls `POST /api/tts/generate` with `{ text: "...", voice: "alloy", preview: true }`
3. Server calls OpenAI TTS API → receives MP3 audio bytes
4. Server returns audio as base64 or streaming response
5. SPA plays audio in browser using Web Audio API
6. Admin listens, edits text if needed, previews again

### Full menu save

When admin clicks "Save & generate audio":

1. SPA collects all text fields: active greeting intro, auto-generated "press X" prompt, all voicemail greetings, all announcements, all sub-menu intros
2. Sends all texts to `POST /api/tts/generate` with `{ texts: [...], voice: "alloy", preview: false }`
3. Server generates each audio file via OpenAI TTS
4. Server writes each MP3 to blob at the appropriate path
5. Server generates TwiML XML files referencing the new audio URLs
6. Server writes XML to blob
7. Returns success — changes are live immediately for the next caller

### Audio format

- Format: MP3
- Sample rate: 16kHz (phone quality — higher is wasted)
- Bitrate: 32kbps mono
- Model: `tts-1` (faster, cheaper — `tts-1-hd` not needed for phone audio)
