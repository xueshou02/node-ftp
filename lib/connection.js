var fs = require('fs'),
    tls = require('tls'),	    tls = require('tls'),
    zlib = require('zlib'),	    zlib = require('zlib'),
    Socket = require('net').Socket,	    net = require('net'),
    EventEmitter = require('events').EventEmitter,	    EventEmitter = require('events').EventEmitter,
    inherits = require('util').inherits,	    inherits = require('util').inherits,
    inspect = require('util').inspect,	    inspect = require('util').inspect,
@@ -66,13 +66,17 @@ var FTP = module.exports = function() {
  this._keepalive = undefined;	  this._keepalive = undefined;
  this._ending = false;	  this._ending = false;
  this._parser = undefined;	  this._parser = undefined;
  this._actvPort = undefined;
  this._actvSock = undefined;
  this.options = {	  this.options = {
    host: undefined,	    host: undefined,
    port: undefined,	    port: undefined,
    user: undefined,	    user: undefined,
    password: undefined,	    password: undefined,
    secure: false,	    secure: false,
    secureOptions: undefined,	    secureOptions: undefined,
    passive: true,
    activeIp: undefined,
    connTimeout: undefined,	    connTimeout: undefined,
    pasvTimeout: undefined,	    pasvTimeout: undefined,
    aliveTimeout: undefined	    aliveTimeout: undefined
@@ -94,16 +98,23 @@ FTP.prototype.connect = function(options) {
      : 'anonymous@';	      : 'anonymous@';
  this.options.secure = options.secure || false;	  this.options.secure = options.secure || false;
  this.options.secureOptions = options.secureOptions;	  this.options.secureOptions = options.secureOptions;
  this.options.passive = options.passive === undefined ? true : options.passive;
  this.options.activeIp = options.activeIp;
  this.options.connTimeout = options.connTimeout || 10000;	  this.options.connTimeout = options.connTimeout || 10000;
  this.options.pasvTimeout = options.pasvTimeout || 10000;	  this.options.pasvTimeout = options.pasvTimeout || 10000;
  this.options.aliveTimeout = options.keepalive || 10000;	  this.options.aliveTimeout = options.keepalive || 10000;


  if (typeof options.debug === 'function')	  if (typeof options.debug === 'function')
    this._debug = options.debug;	    this._debug = options.debug;


  if (!self.options.passive && !self.options.activeIp){
    self.emit('error', new Error('Missing active IP option, fallback to 127.0.0.1'));
    self.options.activeIp = '127.0.0.1';
  }

  var secureOptions,	  var secureOptions,
      debug = this._debug,	      debug = this._debug,
      socket = new Socket();	      socket = new net.Socket();


  socket.setTimeout(0);	  socket.setTimeout(0);
  socket.setKeepAlive(true);	  socket.setKeepAlive(true);
@@ -148,6 +159,49 @@ FTP.prototype.connect = function(options) {
    this._socket = socket;	    this._socket = socket;
  }	  }


  if(!this.options.passive){
    var server = net.createServer(function(socket) {
      debug&&debug('[connection] ACTV socket connected');
      if(self._actvSock){
        self.emit('error', new Error('Unhandled multiple active connections.'));
        return;
      }
      self._actvSock = socket;

      socket.once('end', function(){
        self._actvSock = undefined;
      });

      socket.once('close', function(had_err) {
        self._actvSock = undefined;
      });

      if(self._actvHandler){
        self._actvHandler(socket);
        self._actvHandler = undefined;
      } else {
        socket.on('data', function(chunk) {
          debug&&debug('[active] < ' + inspect(chunk.toString('binary')));
          if (self._parser)
            self._parser.write(chunk);
        });

        socket.on('error', function(err) {
          clearTimeout(self._keepalive);
          self.emit('error', err);
        });
      }
    });
    server.on('error', function(err) {
      self.emit('error', new Error('Listening server error.'));
      self._reset();
    });
    server.listen(function() {
      self._actvPort = server.address().port;
      debug&&debug('[active] Listening on', self._actvPort);
    });
  }

  var noopreq = {	  var noopreq = {
        cmd: 'NOOP',	        cmd: 'NOOP',
        cb: function() {	        cb: function() {
@@ -426,7 +480,7 @@ FTP.prototype.list = function(path, zcomp, cb) {
  } else	  } else
    cmd = 'LIST ' + path;	    cmd = 'LIST ' + path;


  this._pasv(function(err, sock) {	  this._dataconn(function(err, sock) {
    if (err)	    if (err)
      return cb(err);	      return cb(err);


@@ -435,24 +489,32 @@ FTP.prototype.list = function(path, zcomp, cb) {
      return cb();	      return cb();
    }	    }


    var sockerr, done = false, replies = 0, entries, buffer = '', source = sock;	    var sockerr, done = false, replies = 0, entries, buffer = '';
    var decoder = new StringDecoder('utf8');	    var decoder = new StringDecoder('utf8');


    if (zcomp) {	    // passive connection already got actual socket
      source = zlib.createInflate();	    if(self.options.passive){
      sock.pipe(source);	      readFromSource(sock)
    } else {
      self._actvHandler = readFromSource;
    }	    }


    source.on('data', function(chunk) {	    function readFromSource(source){
      buffer += decoder.write(chunk);	      if (zcomp) {
    });	        source = zlib.createInflate();
    source.once('error', function(err) {	        sock.pipe(source);
      if (!sock.aborting)	      }
        sockerr = err;	
    });	
    source.once('end', ondone);	
    source.once('close', ondone);	


      source.on('data', function(chunk) {
        buffer += decoder.write(chunk);
      });
      source.once('error', function(err) {
        if (!sock.aborting)
          sockerr = err;
      });
      source.once('end', ondone);
      source.once('close', ondone);
    }
    function ondone() {	    function ondone() {
      if (decoder) {	      if (decoder) {
        buffer += decoder.end();	        buffer += decoder.end();
@@ -534,7 +596,7 @@ FTP.prototype.get = function(path, zcomp, cb) {
    zcomp = false;	    zcomp = false;
  }	  }


  this._pasv(function(err, sock) {	  this._dataconn(function(err, sock) {
    if (err)	    if (err)
      return cb(err);	      return cb(err);


@@ -546,39 +608,51 @@ FTP.prototype.get = function(path, zcomp, cb) {
    // modify behavior of socket events so that we can emit 'error' once for	    // modify behavior of socket events so that we can emit 'error' once for
    // either a TCP-level error OR an FTP-level error response that we get when	    // either a TCP-level error OR an FTP-level error response that we get when
    // the socket is closed (e.g. the server ran out of space).	    // the socket is closed (e.g. the server ran out of space).
    var sockerr, started = false, lastreply = false, done = false,	    var sockerr, started = false, lastreply = false, done = false, source;
        source = sock;	


    if (zcomp) {	    if(self.options.passive){
      source = zlib.createInflate();	      readFromSource(sock);
      sock.pipe(source);	    } else {
      sock._emit = sock.emit;	      self._actvHandler = function(sock){
      sock.emit = function(ev, arg1) {	        readFromSource(sock);
        cb(undefined, source);
        cb = undefined;
      };
    }

    function readFromSource(sock){
      source = sock;
      if (zcomp) {
        source = zlib.createInflate();
        sock.pipe(source);
        sock._emit = sock.emit;
        sock.emit = function(ev, arg1) {
          if (ev === 'error') {
            if (!sockerr)
              sockerr = arg1;
            return;
          }
          sock._emit.apply(sock, Array.prototype.slice.call(arguments));
        };
      }

      source._emit = source.emit;
      source.emit = function(ev, arg1) {
        if (ev === 'error') {	        if (ev === 'error') {
          if (!sockerr)	          if (!sockerr)
            sockerr = arg1;	            sockerr = arg1;
          return;	          return;
        } else if (ev === 'end' || ev === 'close') {
          if (!done) {
            done = true;
            ondone();
          }
          return;
        }	        }
        sock._emit.apply(sock, Array.prototype.slice.call(arguments));	        source._emit.apply(source, Array.prototype.slice.call(arguments));
      };	      };
    }	    }


    source._emit = source.emit;	
    source.emit = function(ev, arg1) {	
      if (ev === 'error') {	
        if (!sockerr)	
          sockerr = arg1;	
        return;	
      } else if (ev === 'end' || ev === 'close') {	
        if (!done) {	
          done = true;	
          ondone();	
        }	
        return;	
      }	
      source._emit.apply(source, Array.prototype.slice.call(arguments));	
    };	

    function ondone() {	    function ondone() {
      if (done && lastreply) {	      if (done && lastreply) {
        self._send('MODE S', function() {	        self._send('MODE S', function() {
@@ -625,7 +699,7 @@ FTP.prototype.get = function(path, zcomp, cb) {
        // just like a 150	        // just like a 150
        if (code === 150 || code === 125) {	        if (code === 150 || code === 125) {
          started = true;	          started = true;
          cb(undefined, source);	          cb&&cb(undefined, source);
        } else {	        } else {
          lastreply = true;	          lastreply = true;
          ondone();	          ondone();
@@ -743,12 +817,12 @@ FTP.prototype.rmdir = function(path, recursive, cb) { // RMD is optional
  if (!recursive) {	  if (!recursive) {
    return this._send('RMD ' + path, cb);	    return this._send('RMD ' + path, cb);
  }	  }
  	
  var self = this;	  var self = this;
  this.list(path, function(err, list) {	  this.list(path, function(err, list) {
    if (err) return cb(err);	    if (err) return cb(err);
    var idx = 0;	    var idx = 0;
    	
    // this function will be called once per listing entry	    // this function will be called once per listing entry
    var deleteNextEntry;	    var deleteNextEntry;
    deleteNextEntry = function(err) {	    deleteNextEntry = function(err) {
@@ -760,9 +834,9 @@ FTP.prototype.rmdir = function(path, recursive, cb) { // RMD is optional
          return self.rmdir(path, cb);	          return self.rmdir(path, cb);
        }	        }
      }	      }
      	
      var entry = list[idx++];	      var entry = list[idx++];
      	
      // get the path to the file	      // get the path to the file
      var subpath = null;	      var subpath = null;
      if (entry.name[0] === '/') {	      if (entry.name[0] === '/') {
@@ -776,7 +850,7 @@ FTP.prototype.rmdir = function(path, recursive, cb) { // RMD is optional
          subpath = path + '/' + entry.name	          subpath = path + '/' + entry.name
        }	        }
      }	      }
      	
      // delete the entry (recursively) according to its type	      // delete the entry (recursively) according to its type
      if (entry.type === 'd') {	      if (entry.type === 'd') {
        if (entry.name === "." || entry.name === "..") {	        if (entry.name === "." || entry.name === "..") {
@@ -853,6 +927,14 @@ FTP.prototype.restart = function(offset, cb) {




// Private/Internal methods	// Private/Internal methods
FTP.prototype._dataconn = function(cb){
  if(this.options.passive) {
    this._pasv(cb);
  } else {
    this._actv(cb);
  }
};

FTP.prototype._pasv = function(cb) {	FTP.prototype._pasv = function(cb) {
  var self = this, first = true, ip, port;	  var self = this, first = true, ip, port;
  this._send('PASV', function reentry(err, text) {	  this._send('PASV', function reentry(err, text) {
@@ -902,7 +984,7 @@ FTP.prototype._pasv = function(cb) {


FTP.prototype._pasvConnect = function(ip, port, cb) {	FTP.prototype._pasvConnect = function(ip, port, cb) {
  var self = this,	  var self = this,
      socket = new Socket(),	      socket = new net.Socket(),
      sockerr,	      sockerr,
      timedOut = false,	      timedOut = false,
      timer = setTimeout(function() {	      timer = setTimeout(function() {
@@ -950,6 +1032,19 @@ FTP.prototype._pasvConnect = function(ip, port, cb) {
  socket.connect(port, ip);	  socket.connect(port, ip);
};	};


FTP.prototype._actv = function(cb) {
  var self = this,
    ip = self.options.activeIp.replace(/\./g,','),
    port = parseInt(self._actvPort / 256) + ',' + (self._actvPort % 256);

  this._send('PORT ' + ip  + ',' + port, function(err, text, code) {
    if(err){
      cb(new Error(err));
    }
    cb(undefined, self._socket);
  });
}

FTP.prototype._store = function(cmd, input, zcomp, cb) {	FTP.prototype._store = function(cmd, input, zcomp, cb) {
  var isBuffer = Buffer.isBuffer(input);	  var isBuffer = Buffer.isBuffer(input);


@@ -962,7 +1057,7 @@ FTP.prototype._store = function(cmd, input, zcomp, cb) {
  }	  }


  var self = this;	  var self = this;
  this._pasv(function(err, sock) {	  this._dataconn(function(err, sock) {
    if (err)	    if (err)
      return cb(err);	      return cb(err);


@@ -1006,6 +1101,9 @@ FTP.prototype._store = function(cmd, input, zcomp, cb) {
        }	        }


        if (code === 150 || code === 125) {	        if (code === 150 || code === 125) {
          if(!self.options.passive){
            dest = self._actvSock;
          }
          if (isBuffer)	          if (isBuffer)
            dest.end(input);	            dest.end(input);
          else if (typeof input === 'string') {	          else if (typeof input === 'string') {
@@ -1053,10 +1151,13 @@ FTP.prototype._send = function(cmd, cb, promote) {
FTP.prototype._reset = function() {	FTP.prototype._reset = function() {
  if (this._pasvSock && this._pasvSock.writable)	  if (this._pasvSock && this._pasvSock.writable)
    this._pasvSock.end();	    this._pasvSock.end();
  if (this._actvSock && this._actvSock.writable)
    this._actvSock.end();
  if (this._socket && this._socket.writable)	  if (this._socket && this._socket.writable)
    this._socket.end();	    this._socket.end();
  this._socket = undefined;	  this._socket = undefined;
  this._pasvSock = undefined;	  this._pasvSock = undefined;
  this._actvSock = undefined;
  this._feat = undefined;	  this._feat = undefined;
  this._curReq = undefined;	  this._curReq = undefined;
  this._secstate = undefined;	  this._secstate = undefined;
