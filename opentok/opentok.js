// ----------  Module depedencies  ----------
var _ = require('underscore')._,
    sax = require('cloud/opentok/sax'),
    Base64 = require('cloud/opentok/Base64'),
    CryptoJS = require('cloud/opentok/CryptoJS'),
    xml2js = require('cloud/opentok/xml2js'),
    events = require('cloud/opentok/events');
    // TODO: extract httpRequest as a dependency

// ----------  Constants  -----------
var API_SCHEME = "https",
    API_HOST = "api.opentok.com",
    ROLE = {
      PUBLISHER: 'publisher',
      SUBSCRIBER: 'subscriber',
      MODERATOR: 'moderator'
    },
    TOKEN_SENTINEL = 'T1==',
    ENDPOINTS = {
      SESSION: { method: "POST", path: "/hl/session/create" },
      ARCHIVE_MANIFEST: { method: "GET", path: "/archive/getmanifest/ARCHIVE_ID" },
      ARCHIVE_RESOUCE_URL : { method: "GET", path: "/hl/archive/url/ARCHIVE_ID/RESOURCE_ID" }
    },
    AUTH = {
      PARTNER : "X-TB-PARTNER-AUTH",
      TOKEN : "X-TB-TOKEN-AUTH"
    };

// TODO: return's everywhere are getting really messy, can I inline them?
// TODO: wrap console.log, console.warn, and console.error (and let them take
// an object which is automatically JSON.strigify-ed)
// TODO: break into separate files
// TODO: OpenTokSession object

//  ------------  OpenTokSDK  ------------
function OpenTokSDK(apiKey, apiSecret) {
  this.apiKey = apiKey;
  this.apiSecret = apiSecret;
  return this;
}

// Expose ROLE constants on SDK object
OpenTokSDK.prototype.ROLE = ROLE;

// Get the SDK info and log it (useful for debugging)
OpenTokSDK.prototype.info = function(input) {
  var info = "OpenTokSDK object: \n" +
              "  API Key: " + this.apiKey + "\n" +
              "  API Secret: " + this.apiSecret + "\n";
  console.log(info);
  return info;
};

// Create Sessions
OpenTokSDK.prototype.createSession = function(properties, cb) {
  var params;

  // properties are optional
  if (cb === undefined) { cb = properties; properties = {}; }

  // merge default values with passed in properties
  params = _.defaults(properties, { location_hint : 'localhost' });

  // send the request
  this.apiRequest(ENDPOINTS.SESSION, AUTH.PARTNER, { data: params }, function(err, response) {
    if (err) {
      console.error("OpenTok: Error while creating session\n" + err.message);
      cb(err);
      return;
    }
    console.log("OpenTok: Response from creating session\n" + JSON.stringify(response));

    parseSessionId(response.text, function(err, sessionId) {
      cb(null, sessionId);
    });
    return;
  });
};

// Create an OpenTokArchive object
OpenTokSDK.prototype.getArchive = function(archiveId, cb) {
  // TODO: cache archive objects on SDK object

  var endpointOptions,
      authOptions,
      self = this;

  if (!archiveId) {
    console.error("OpenTok: Cannot get archive, archiveId is falsy");
    cb(new Error("OpenTok: Cannot get archive, archiveId is falsy"));
    return;
  }

  endpointOptions = {
    "ARCHIVE_ID" : archiveId
  };

  // creating the authOptions requires first creating a temporary session
  this.createSession(function(err, sessionId) {
    if (err) {
      console.error("OpenTok: Error while generating temporary session for retreiving archive manifest\n" + err.message);
      cb(err);
      return;
    }
    authOptions = [ sessionId, { role : ROLE.MODERATOR } ];
    resumeWithAuthOptions();
  });

  // continuation for once authOptions are ready
  function resumeWithAuthOptions() {
    self.apiRequest(ENDPOINTS.ARCHIVE_MANIFEST, AUTH.TOKEN, { endpoint: endpointOptions, auth: authOptions }, function(err, response) {
      if (err) {
        console.error("OpenTok: Error while retreiving archive manifest\n" + err.message);
        cb(err);
        return;
      }
      console.log("OpenTok: Response from retrieving archive manifest:\n" + JSON.stringify(response));

      var archive = new OpenTokArchive(response.text, self);
      archive.on('parsed', function(err) {
        if (err) {
          cb(err);
          return;
        }
        cb(null, archive);
        return;
      });
      archive.parseManifest();
      return;
    });
    return;
  }
  return;

};

// Generate a Token
OpenTokSDK.prototype.generateToken = function(sessionId, options) {
  var params, unsignedData, signedData, decodedPayload, payload;

  // check params
  if (!sessionId || typeof sessionId !== 'string') return null;
  if (!options) options = {};

  // substitute default data
  params = _.defaults(options, {
    "session_id" : sessionId,
    "create_time" : Math.floor((new Date()).getTime() / 1e3),
    "expire_time" : Math.floor((new Date()).getTime() / 1e3) + 86400, // 24hrs
    "role" : ROLE.PUBLISHER,
    "connection_data" : '',
    "nonce" : Math.floor(1e6 * Math.random())
  });

  // sign and encode data
  unsignedData = makeQueryString(params);
  signedData = CryptoJS.HmacSHA1(unsignedData, this.apiSecret);
  decodedPayload = {
    "partner_id" : this.apiKey,
    "sig" : signedData + ':' + unsignedData
  };
  payload = Base64.encode(makeQueryString(decodedPayload));

  return TOKEN_SENTINEL + payload;
};

// Make an API request
OpenTokSDK.prototype.apiRequest = function(endpoint, authScheme, options, cb) {

  // options is optional
  if (cb === undefined) { cb = options; options = {}; }

  var requestOptions = {
    url: urlFromEndpoint(endpoint, options.endpoint),
    method: methodFromEndpoint(endpoint),
    headers: {},
    body: options.data || {},
    success: function(response) {
      cb(null, response);
    },
    error: function(response) {
      cb(new Error("Request failed with response code " + response.status + "\n" +
                   "Raw response: \n" + response.text + "\n"));
    }
  };

  if (authScheme === AUTH.PARTNER) {
    requestOptions.headers[authScheme] = this.apiKey + ':' + this.apiSecret;
  } else if (authScheme === AUTH.TOKEN) {
    requestOptions.headers[authScheme] = this.generateToken.apply( this, options.auth );
  } else {
    console.warn("OpenTok: No known authentication scheme chosen for the following request: \n" +
      JSON.stringify(requestOptions) + "\n");
  }

  Parse.Cloud.httpRequest(requestOptions);
  console.log("OpenTok: Sent the following request: \n" + JSON.stringify(requestOptions) + "\n");
  return;
};

// ----------------- OpenTokArchive ---------------
function OpenTokArchive(rawManifest, sdk) {
  this.rawManifest = rawManifest;
  this.sdk = sdk;

  return this;
}
OpenTokArchive.prototype = Object.create(events.EventEmitter.prototype);

// Extract the archiveId, title, resources[], timeline[] from the raw xml manifest
OpenTokArchive.prototype.parseManifest = function() {
  var parser = new xml2js.Parser(),
      self = this;
  parser.on('error', function(err) {
    console.error('OpenTok: Error parsing archive manifest \n' + err.message);
    self.emit('parseerror', err);
    return;
  });
  parser.on('end', function(result) {
    var i, errorMessage, videoData, eventData;

    console.log('OpenTok: Archive manifest finished parsing\n' + JSON.stringify(result));

    // check for errors
    if (result.Errors) {
      errorMessage = extractErrorMessage(result.Errors.error);
      console.error("OpenTok: Archive manifest response contained errors\n" + JSON.stringify(errorMessage));
      self.emit('parsed', new Error(errorMessage));
      return;
    }

    self.archiveId = result.manifest.$.archiveid;
    // TODO: deal with "null" title
    if (result.manifest.$.title) { self.title = result.manifest.$.title; }

    if (result.manifest.resources[0]) {
      self.resources = [];
      for (i in result.manifest.resources[0].video) {
        videoData = result.manifest.resources[0].video[i];
        self.resources.push(new OpenTokArchiveVideo(videoData));
      }
    }

    if (result.manifest.timeline) {
      self.timeline = [];
      for (i in result.manifest.timeline[0].event) {
        eventData = result.manifest.timeline[0].event[i];
        self.timeline.push(new OpenTokArchiveEvent(eventData));
      }
    }

    self.emit('parsed');
    return;
  });
  parser.parseString(this.rawManifest);
  return;
};

// TODO: toJSON - include JSON representation of resources and timeline

// ----------------  OpenTokArchiveVideo --------------
function OpenTokArchiveVideo(videoData) {
  this.id = videoData.$.id;
  this.length = videoData.$.length;
  if (videoData.$.name) {
    this.name = videoData.$.name;
  }
  return this;
}

// TODO: getURL, delete

// ----------------  OpenTokArchiveEvent --------------
function OpenTokArchiveEvent(eventData) {
  this.id = eventData.$.id;
  this.type = eventData.$.type;
  this.offset = eventData.$.offset;
  return this;
}

// -----------------  Helpers  -----------------

// Parsing helpers
parseSessionId = function(xml, cb) {
  var parser = sax.parser(true),
      tagName = "session_id",
      isWithinTag = false,
      value = '';

  // TODO: implement error handling

  parser.onopentag = function(node) {
    if (node.name === tagName) {
      isWithinTag = true;
    }
  };
  parser.ontext = function(t) {
    if (isWithinTag) {
      value += t;
    }
  };
  parser.onclosetag = function(name) {
    if (name === tagName) {
      isWithinTag = false;
      // clear event handlers from parser
      parser.onopentag = parser.ontext = parser.onclosetag = null;
      cb(null, value);
      // resume at the end so that the next write operation has a clean buffer
      parser.resume();
    }
  };
  parser.write(xml).close();
  return;
};

// Endpoint Helpers
function urlFromEndpoint(endpoint, options) {
  if (endpoint === ENDPOINTS.ARCHIVE_MANIFEST) {
    // TODO: this could be made more generic
    endpoint.path = endpoint.path.replace('ARCHIVE_ID', options.ARCHIVE_ID);
  }
  return API_SCHEME + "://" + API_HOST + endpoint.path;
}
function methodFromEndpoint(endpoint) {
  return endpoint.method;
}

// String Helpers
function makeQueryString(params) {
    return _.map(params, function (value, key) {
        return key + '=' + value;
    }).join('&');
}

function extractErrorMessage(errors) {
  var error, errorData, key, errorMessage = "";
  for (var i=0, len=errors.length; i<len; ++i) {
    error = errors[i];
    for (key in error) {
      if (key !== '$' && error.hasOwnProperty(key)) {
        errorData = error[key];
        errorMessage += errorData[0].$.message;
        continue;
      }
    }
  }
  return errorMessage;
}

// Export one main function, to create a new OpenTokSDK
exports.createOpenTokSDK = function(apiKey, apiSecret) {
  return new OpenTokSDK(apiKey, apiSecret);
};
exports.ROLE = ROLE;
