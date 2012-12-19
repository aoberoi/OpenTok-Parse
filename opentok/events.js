// Implementation yanked from https://github.com/creationix/eventemitter-browser
// EventEmitter.prototype.removeAllListeners is mine

function EventEmitter() {}

EventEmitter.prototype.on = function (name, callback) {
  if (!this.hasOwnProperty("_handlers")) this._handlers = {};
  var handlers = this._handlers;
  if (!handlers.hasOwnProperty(name)) handlers[name] = [];
  var list = handlers[name];
  list.push(callback);
};
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

EventEmitter.prototype.once = function (name, callback) {
  this.on(name, callback);
  this.on(name, remove);
  function remove() {
    this.off(name, callback);
    this.off(name, remove);
  }
};

EventEmitter.prototype.emit = function (name/*, args...*/) {
  if (!this.hasOwnProperty("_handlers")) return;
  var handlers = this._handlers;
  if (!handlers.hasOwnProperty(name)) return;
  var list = handlers[name];
  var args = Array.prototype.slice.call(arguments, 1);
  for (var i = 0, l = list.length; i < l; i++) {
    if (!list[i]) continue;
    list[i].apply(this, args);
  }
};

EventEmitter.prototype.off = function (name, callback) {
  if (!this.hasOwnProperty("_handlers")) return;
  var handlers = this._handlers;
  if (!handlers.hasOwnProperty(name)) return;
  var list = handlers[name];
  var index = list.indexOf(callback);
  if (index < 0) return;
  list[index] = false;
  if (index === list.length - 1) {
    while (index >= 0 && !list[index]) {
      list.length--;
      index--;
    }
  }
};
EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

EventEmitter.prototype.removeAllListeners = function(name) {
  if (!this.hasOwnProperty("_handlers")) return;
  var handlers = this._handlers;
  if (name && !handlers.hasOwnProperty(name)) return;
  for (var eventType in handlers) {
    if ( (name && eventType == name && handlers.hasOwnProperty(eventType)) || 
         (handlers.hasOwnProperty(eventType)) ) {
           var list = handlers[eventType];
           for (var i=0, len=list.length; i<len; ++i) {
             this.removeListener(eventType, list[i]);
           }
    }
  }
  return;
};

exports.EventEmitter = EventEmitter;
