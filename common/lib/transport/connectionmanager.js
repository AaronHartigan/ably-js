var ConnectionManager = (function() {
	var readCookie = (typeof(Cookie) !== 'undefined' && Cookie.read);
	var createCookie = (typeof(Cookie) !== 'undefined' && Cookie.create);
	var connectionIdCookie = 'ably-connection-id';
	var connectionSerialCookie = 'ably-connection-serial';
	var messagetypes = (typeof(clientmessage_refs) == 'object') ? clientmessage_refs : require('../nodejs/lib/protocol/clientmessage_types');
	var actions = messagetypes.TAction;

	var noop = function() {};

	var states = {
		initialized:  {state: 'initialized',  terminal: false, queueEvents: true,  sendEvents: false},
		connecting:   {state: 'connecting',   terminal: false, queueEvents: true,  sendEvents: false, retryDelay: Defaults.connectTimeout, failState: 'disconnected'},
		connected:    {state: 'connected',    terminal: false, queueEvents: false, sendEvents: true, failState: 'disconnected'},
		disconnected: {state: 'disconnected', terminal: false, queueEvents: true,  sendEvents: false, retryDelay: Defaults.disconnectTimeout},
		suspended:    {state: 'suspended',    terminal: false, queueEvents: false, sendEvents: false, retryDelay: Defaults.suspendedTimeout},
		closed:       {state: 'closed',       terminal: false, queueEvents: false, sendEvents: false},
		failed:       {state: 'failed',       terminal: true,  queueEvents: false, sendEvents: false}
	};

	var channelMessage = function(msg) {
		var action = msg.action;
		return (action == actions.MESSAGE || action == actions.PRESENCE);
	};

	function TransportParams(options, host, mode, connectionId, connectionSerial) {
		this.options = options;
		this.binary = !options.useTextProtocol;
		this.host = host;
		this.mode = mode;
		this.connectionId = connectionId;
		this.connectionSerial = connectionSerial;
	}

	TransportParams.prototype.getConnectParams = function(params) {
		params = params ? Utils.prototypicalClone(params) : {};
		var options = this.options;
		switch(this.mode) {
			case 'resume':
				params.resume = this.connectionId;
				if(this.connectionSerial !== undefined)
					params.connection_serial = this.connectionSerial;
				break;
			case 'recover':
				if(options.recover === true) {
					params.recover = readCookie(connectionIdCookie);
					params.connection_serial = readCookie(connectionSerialCookie);
				} else {
					var match = options.recover.match(/^(\w+):(\w+)$/);
					if(match) {
						params.recover = match[1];
						params.connection_serial = match[2];
					}
				}
				break;
			default:
		}
		params.binary = this.binary;
		params.timestamp = Date.now();
		return params;
	};

	function PendingMessage(msg, callback) {
		this.msg = msg;
		var action = msg.action;
		this.ackRequired = channelMessage(msg);
		this.callback = callback;
		this.merged = false;
	}

	/* public constructor */
	function ConnectionManager(realtime, options) {
		EventEmitter.call(this);
		this.realtime = realtime;
		this.options = options;
		this.state = states.initialized;
		this.error = null;

		this.queuedMessages = [];
		this.pendingMessages = [];
		this.msgSerial = 0;
		this.connectionId = undefined;
		this.connectionSerial = undefined;

		this.httpTransports = Utils.intersect((options.transports || Defaults.httpTransports), ConnectionManager.httpTransports);
		this.transports = Utils.intersect((options.transports || Defaults.transports), ConnectionManager.transports);
		this.upgradeTransports = Utils.arrSubtract(this.transports, this.httpTransports);

		this.httpHosts = Defaults.getHosts(options);
		this.transport = null;
		this.pendingTransport = null;
		this.host = null;

		Logger.logAction(Logger.LOG_MINOR, 'Realtime.ConnectionManager()', 'started');
		Logger.logAction(Logger.LOG_MICRO, 'Realtime.ConnectionManager()', 'requested transports = [' + (options.transports || Defaults.transports) + ']');
		Logger.logAction(Logger.LOG_MICRO, 'Realtime.ConnectionManager()', 'available http transports = [' + this.httpTransports + ']');
		Logger.logAction(Logger.LOG_MICRO, 'Realtime.ConnectionManager()', 'available transports = [' + this.transports + ']');
		Logger.logAction(Logger.LOG_MICRO, 'Realtime.ConnectionManager()', 'http hosts = [' + this.httpHosts + ']');

		if(!this.transports.length) {
			var msg = 'no requested transports available';
			Logger.logAction(Logger.LOG_ERROR, 'realtime.ConnectionManager()', msg);
			throw new Error(msg);
		}

		/* intercept close event in browser to persist connection id if requested */
		if(createCookie && options.recover)
			window.addEventListener('beforeunload', function() { self.persistConnection(); });
	}
	Utils.inherits(ConnectionManager, EventEmitter);

	/*********************
	 * transport management
	 *********************/

	ConnectionManager.httpTransports = {};
	ConnectionManager.transports = {};

	ConnectionManager.prototype.chooseTransport = function(callback) {
		Logger.logAction(Logger.LOG_MAJOR, 'ConnectionManager.chooseTransport()', '');
		/* if there's already a transport, we're done */
		if(this.transport) {
			Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.chooseTransport()', 'Transport already established');
			callback(null, this.transport);
			return;
		}

		/* set up the transport params */
		/* first attempt the main host; no need to check for general connectivity first.
		 * Inherit any connection state */
		var mode = this.connectionId ? 'resume' : (this.options.recover ? 'recover' : 'clean');
		var transportParams = new TransportParams(this.options, null, mode, this.connectionId, this.connectionSerial);
		Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.chooseTransport()', 'Transport recovery mode = ' + mode + (mode == 'clean' ? '' : '; connectionId = ' + this.connectionId + '; connectionSerial = ' + this.connectionSerial));
		var self = this;

		/* if there are no http transports, just choose from the available transports,
		 * falling back to the first host only;
		 * NOTE: this behaviour will never apply with a default configuration. */
		if(!this.httpTransports.length) {
			transportParams.host = this.httpHosts[0];
			Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.chooseTransport()', 'No http transports available; ignoring fallback hosts');
			this.chooseTransportForHost(transportParams, self.transports.slice(), callback);
			return;
		}

		/* first try to establish an http transport */
		this.chooseHttpTransport(transportParams, function(err, httpTransport) {
			if(err) {
				Logger.logAction(Logger.LOG_ERROR, 'ConnectionManager.chooseTransport()', 'Unexpected error establishing transport; err = ' + err);
				/* http failed, so nothing's going to work */
				callback(err);
				return;
			}
			Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.chooseTransport()', 'Establishing http transport: ' + httpTransport);
			callback(null, httpTransport);
			/* we have the http transport; if there is a potential upgrade
			 * transport, lets see if we can upgrade to that. We won't
			  * be trying any fallback hosts, so we know the host to use */
			if(self.upgradeTransports.length) {
				/* we can't initiate the selection of the upgrade transport until we have
				 * the actual connection, since we need the connectionId */
				httpTransport.on('connected', function(error, connectionId) {
					Logger.logAction(Logger.LOG_MAJOR, 'ConnectionManager.chooseTransport()', 'upgrading ... connectionId = ' + connectionId);
					transportParams = new TransportParams(self.options, transportParams.host, 'resume', connectionId, self.connectionSerial);
					self.chooseTransportForHost(transportParams, self.upgradeTransports.slice(), noop);
				});
			}
  		});
	};

	/**
	 * Attempt to connect to a specified host using a given
	 * list of candidate transports in descending priority order
	 * @param transportParams
	 * @param candidateTransports
	 * @param callback
	 */
	ConnectionManager.prototype.chooseTransportForHost = function(transportParams, candidateTransports, callback) {
		var candidate = candidateTransports.shift();
		if(!candidate) {
			var err = new Error('Unable to connect (no available transport)');
			err.statusCode = 404;
			err.code = 80000;
			callback(err);
			return;
		}
		var self = this;
		Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.chooseTransportForHost()', 'trying ' + candidate);
		(ConnectionManager.transports[candidate]).tryConnect(this, this.realtime.auth, transportParams, function(err, transport) {
			if(err) {
				self.chooseTransportForHost(transportParams, candidateTransports, callback);
				return;
			}
			Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.chooseTransport()', 'transport ' + candidate + ' connecting');
			self.setTransportPending(transport);
			callback(null, transport);
		});
	};

	/**
	 * Try to establish a transport on an http transport, checking for
	 * network connectivity and trying fallback hosts if applicable
	 * @param transportParams
	 * @param callback
	 */
	ConnectionManager.prototype.chooseHttpTransport = function(transportParams, callback) {
		var candidateHosts = this.httpHosts.slice();
		/* first try to establish a connection with the priority host with http transport */
		var host = candidateHosts.shift();
		if(!host) {
			var err = new Error('Unable to connect (no available host)');
			err.statusCode = 404;
			err.code = 80000;
			callback(err);
			return;
		}
		transportParams.host = host;
		var self = this;

		/* this is what we'll be doing if the attempt for the main host fails */
		function tryFallbackHosts() {
			/* if there aren't any fallback hosts, fail */
			if(!candidateHosts.length) {
				var err = new Error('Unable to connect (no available host)');
				err.statusCode = 404;
				err.code = 80000;
				callback(err);
				return;
			}
			/* before trying any fallback (or any remaining fallback) we decide if
			 * there is a problem with the ably host, or there is a general connectivity
			 * problem */
			ConnectionManager.httpTransports[self.httpTransports[0]].checkConnectivity(function(err, connectivity) {
				/* we know err won't happen but handle it here anyway */
				if(err) {
					callback(err);
					return;
				}
				if(!connectivity) {
					/* the internet isn't reachable, so don't try the fallback hosts */
					var err = new Error('Unable to connect (network unreachable)');
					err.statusCode = 404;
					err.code = 80000;
					callback(err);
					return;
				}
				/* the network is there, so there's a problem with the main host, or
				 * its dns. Try the fallback hosts. We could try them simultaneously but
				 * that would potentially cause a huge spike in load on the load balancer */
				transportParams.host = Utils.arrRandomElement(candidateHosts);
				self.chooseTransportForHost(transportParams, self.httpTransports.slice(), function(err, httpTransport) {
					if(err) {
						tryFallbackHosts();
						return;
					}
					/* succeeded */
					callback(null, httpTransport);
				});
			});
		}

		this.chooseTransportForHost(transportParams, this.httpTransports.slice(), function(err, httpTransport) {
			if(err) {
				tryFallbackHosts();
				return;
			}
			/* succeeded */
			callback(null, httpTransport);
		});
	};

	/**
	 * Called when a transport is indicated to be viable, and the connectionmanager
	 * expects to activate this transport as soon as it is connected.
	 * @param host
	 * @param transport
	 */
	ConnectionManager.prototype.setTransportPending = function(transport) {
		Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.setTransportPending()', 'transport = ' + transport);
		if(this.state == states.closed) {
			/* the connection was closed when we were away
			 * attempting this transport so close */
			transport.close(true);
			return;
 		}
		/* if there was already a pending transport, abandon it */
		if(this.pendingTransport)
			this.pendingTransport.close(false);

		/* this is now the pending transport */
		this.pendingTransport = transport;

		var self = this;
		var handleTransportEvent = function(state) {
			return function(error, connectionId) {
				Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.setTransportPending', 'on state = ' + state);
				if(error && error.reason)
					Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.setTransportPending', 'reason =  ' + error.reason);
				if(connectionId)
					Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.setTransportPending', 'connectionId =  ' + connectionId);

				/* handle activity transition */
				var notifyState;
				if(state == 'connected') {
					self.activateTransport(transport, connectionId);
					notifyState = true;
				} else {
					notifyState = self.deactivateTransport(transport);
				}

				/* if this is the active transport, notify clients */
				if(notifyState)
					self.notifyState({state:state, error:error});
			};
		};
		var events = ['connected', 'disconnected', 'closed', 'failed'];
		for(var i = 0; i < events.length; i++) {
			var event = events[i];
			transport.on(event, handleTransportEvent(event));
		}
		this.emit('transport.pending', transport);
	};

	/**
	 * Called when a transport is connected, and the connectionmanager decides that
	 * it will now be the active transport.
	 * @param transport the transport instance
	 * @param connectionId the id of the new active connection
	 * @param mode the nature of the activation:
	 *   'clean': new connection;
	 *   'recover': new connection with recoverable messages;
	 *   'resume': uninterrupted resumption of connection without loss of messages
	 */
	ConnectionManager.prototype.activateTransport = function(transport, connectionId) {
		Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.activateTransport()', 'transport = ' + transport + '; connectionId = ' + connectionId);
		/* if the connectionmanager moved to the closed state before this
		 * connection event, then we won't activate this transport */
		if(this.state == states.closed)
			return;

 		/* Terminate any existing transport */
		var existingTransport = this.transport;
 		if(existingTransport) {
			 this.transport = null;
			 existingTransport.close(false);
		}
		existingTransport = this.pendingTransport;
		if(existingTransport)
			this.pendingTransport = null;

		/* the given transport is connected; this will immediately
		 * take over as the active transport */
		this.transport = transport;
		this.host = transport.params.host;
		if(connectionId && this.connectionId != connectionId)  {
			this.realtime.connection.id = this.connectionId = connectionId;
			this.msgSerial = 0;
		}

 		/* set up handler for events received on this transport */
		var self = this;
		transport.on('ack', function(serial, count) {
			Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager on(ack)', 'serial = ' + serial + '; count = ' + count);
			self.ackMessage(serial, count);
		});
		transport.on('nack', function(serial, count, err) {
			Logger.logAction(Logger.LOG_ERROR, 'ConnectionManager on(nack)', 'serial = ' + serial + '; count = ' + count + '; err = ' + err);
			if(!err) {
				err = new Error('Unknown error');
				err.statusCode = 500;
				err.code = 50001;
				err.reason = 'Unable to send message; channel not responding';
			}
			self.ackMessage(serial, count, err);
		});
		this.emit('transport.active', transport, connectionId, transport.params);
	};

	/**
	 * Called when a transport is no longer the active transport. This can occur
	 * in any transport connection state.
	 * @param transport
	 */
	ConnectionManager.prototype.deactivateTransport = function(transport) {
		var wasActive = this.transport === transport;
		Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.deactivateTransport()', 'transport = ' + transport);
		transport.off('ack');
		transport.off('nack');
		if(wasActive)
			this.transport = this.host = null;
		else if(this.pendingTransport === transport)
			this.pendingTransport = null;

		this.emit('transport.inactive', transport);
		return wasActive;
	};

	/**
	 * Called when the connectionmanager wants to persist transport
	 * state for later recovery
	 */
	ConnectionManager.prototype.persistConnection = function() {
		if(createCookie) {
			if(this.connectionId)
				createCookie(connectionIdCookie, this.connectionId);
			if(this.connectionSerial)
				createCookie(connectionSerialCookie, this.connectionSerial);
		}
	};

	/*********************
	 * state management
	 *********************/

	ConnectionManager.prototype.getStateError = function() {
		return ConnectionError[this.state.state];
	};

	ConnectionManager.activeState = function(state) {
		return state.queueEvents || state.sendEvents;
	};

	ConnectionManager.prototype.enactStateChange = function(stateChange) {
		Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.enactStateChange', 'setting new state: ' + stateChange.current);
		this.state = states[stateChange.current];
		if(this.state.terminal)
			this.error = stateChange.error;
		this.emit('connectionstate', stateChange, this.transport);
	};

	/****************************************
	 * ConnectionManager connection lifecycle
	 ****************************************/

	ConnectionManager.prototype.startConnectTimer = function() {
		var self = this;
		this.connectTimer = setTimeout(function() {
			if(self.connectTimer) {
				Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager connect timer expired', 'requesting new state: ' + states.connecting.failState);
				self.notifyState({state: states.connecting.failState});
			}
		}, Defaults.connectTimeout);
	};

	ConnectionManager.prototype.cancelConnectTimer = function() {
		if(this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = undefined;
		}
	};

	ConnectionManager.prototype.startSuspendTimer = function() {
		var self = this;
		if(this.suspendTimer)
			return;
		this.suspendTimer = setTimeout(function() {
			if(self.suspendTimer) {
				Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager suspend timer expired', 'requesting new state: suspended');
				states.connecting.failState = 'suspended';
				states.connecting.queueEvents = false;
				self.notifyState({state: 'suspended'});
			}
		}, Defaults.suspendedTimeout);
	};

	ConnectionManager.prototype.cancelSuspendTimer = function() {
		states.connecting.failState = 'disconnected';
		states.connecting.queueEvents = true;
		if(this.suspendTimer) {
			clearTimeout(this.suspendTimer);
			delete this.suspendTimer;
		}
	};

	ConnectionManager.prototype.startRetryTimer = function(interval) {
		var self = this;
		this.retryTimer = setTimeout(function() {
			Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager retry timer expired', 'retrying');
			self.requestState({state: 'connecting'});
		}, interval);
	};

	ConnectionManager.prototype.cancelRetryTimer = function() {
		if(this.retryTimer) {
			clearTimeout(this.retryTimer);
			delete this.retryTimer;
		}
	};

	ConnectionManager.prototype.notifyState = function(indicated) {
		/* do nothing if we're already in the indicated state
		 * or we're unable to move from the current state*/
		if(this.state.terminal || indicated.state == this.state.state)
			return; /* silently do nothing */

		/* if we consider the transport to have failed
		 * (perhaps temporarily) then remove it, so we
		 * can re-select when we re-attempt connection */
		Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.notifyState()', 'new state: ' + indicated.state);
		var newState = states[indicated.state];
		if(!newState.sendEvents) {
			if(this.transport) {
				Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.notifyState()', 'deleting transport ' + this.transport);
				this.transport.dispose();
				delete this.transport;
			}
		}

		/* kill running timers, including suspend if connected */
		this.cancelConnectTimer();
		this.cancelRetryTimer();
		if(indicated.state == 'connected') {
			this.cancelSuspendTimer();
		}

		/* set up retry and suspended timers */
		var change = new ConnectionStateChange(this.state.state, newState.state, newState.retryDelay, (indicated.error || ConnectionError[newState.state]));
		if(newState.retryDelay)
			this.startRetryTimer(newState.retryDelay);

		/* implement the change and notify */
		this.enactStateChange(change);
		if(this.state.sendEvents)
			this.sendQueuedMessages();
		else if(this.state.queueEvents)
			this.queuePendingMessages();
	};

	ConnectionManager.prototype.requestState = function(request) {
		/* kill running timers, as this request supersedes them */
		this.cancelConnectTimer();
		this.cancelRetryTimer();
		if(request.state == this.state.state)
			return; /* silently do nothing */
		if(this.state.terminal)
			throw new Error(this.error.reason);
		if(request.state == 'connecting') {
			if(this.state.state == 'connected')
				return; /* silently do nothing */
			this.connectImpl();
		} else {
			if(this.pendingTransport) {
				this.pendingTransport.close(true);
				this.pendingTransport = null;
			}
			if(request.state == 'failed') {
				if(this.transport) {
					this.transport.abort(request.reason);
					this.transport = null;
				}
			} else if(request.state = 'closed') {
				this.cancelConnectTimer();
				this.cancelRetryTimer();
				this.cancelSuspendTimer();
				if(this.transport) {
					this.transport.close(true);
					this.transport = null;
				}
			}
		}
		if(request.state != this.state.state) {
			var newState = states[request.state];
			var change = new ConnectionStateChange(this.state.state, newState.state, newState.retryIn, (request.error || ConnectionError[newState.state]));
			this.enactStateChange(change);
		}
	};

	ConnectionManager.prototype.connectImpl = function() {
		Logger.logAction(Logger.LOG_MINOR, 'ConnectionManager.connectImpl()', 'starting connection');
		this.startSuspendTimer();
		this.startConnectTimer();

		var self = this;
		var auth = this.realtime.auth;
		var connectErr = function(err) {
			Logger.logAction(Logger.LOG_ERROR, 'ConnectionManager.connectImpl()', err);
			if(err.statusCode == 401 && err.message.indexOf('expire') != -1 && auth.method == 'token') {
				/* re-get a token */
				auth.getToken(true, function(err) {
					if(err) {
						connectErr(err);
						return;
					}
					self.connectImpl();
				});
			}
			/* FIXME: decide if fatal */
			var fatal = false;
			if(fatal)
				self.notifyState({state: 'failed', error: err});
			else
				self.notifyState({state: states.connecting.failState, error: err});
		};

		var tryConnect = function() {
			self.chooseTransport(function(err, transport) {
				if(err) {
					connectErr(err);
					return;
				}
				/* nothing to do .. as transport connection is initiated
				 * in chooseTransport() */
			});
		};

		if(auth.method == 'basic') {
			tryConnect();
		} else {
			auth.authorise(false, function(err) {
				if(err)
					connectErr(err);
				else
					tryConnect();
			});
		}
	};

	/******************
	 * event queueing
	 ******************/

	ConnectionManager.prototype.send = function(msg, queueEvents, callback) {
		callback = callback || noop;
		var state = this.state;

		if(state.sendEvents) {
			Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.send()', 'sending event');
			this.sendImpl(new PendingMessage(msg, callback));
			return;
		}
		if(state.queueEvents) {
			if(queueEvents) {
				this.queue(msg, callback);
			} else {
				Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.send()', 'rejecting event');
				callback(this.error);
			}
		}
	};

	ConnectionManager.prototype.sendImpl = function(pendingMessage) {
		var msg = pendingMessage.msg;
		if(pendingMessage.ackRequired) {
			msg.msgSerial = this.msgSerial++;
			this.pendingMessages.push(pendingMessage);
		}
		try {
			this.transport.send(msg, function(err) {
				/* FIXME: schedule a retry directly if we get an error */
			});
		} catch(e) {
			Logger.logAction(Logger.LOG_ERROR, 'ConnectionManager.sendQueuedMessages()', 'Unexpected exception in transport.send(): ' + e);
		}
	};

	ConnectionManager.prototype.ackMessage = function(serial, count, err) {
		Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.ackMessage()', 'serial = ' + serial + '; count = ' + count);
		err = err || null;
		var pendingMessages = this.pendingMessages;
		var firstPending = pendingMessages[0];
		if(firstPending) {
			var startSerial = firstPending.msg.msgSerial;
			var ackSerial = serial + count; /* the serial of the first message that is *not* the subject of this call */
			if(ackSerial > startSerial) {
				var ackMessages = pendingMessages.splice(0, (ackSerial - startSerial));
				for(var i = 0; i < ackMessages.length; i++) {
					ackMessages[i].callback(err);
				}
			}
		}
	};

	ConnectionManager.prototype.queue = function(msg, callback) {
		Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.queue()', 'queueing event');
		var lastQueued = this.queuedMessages[this.queuedMessages.length - 1];
		if(lastQueued && RealtimeChannel.mergeTo(lastQueued.msg, msg)) {
			if(!lastQueued.merged) {
				lastQueued.callback = new Multicaster([lastQueued.callback]);
				lastQueued.merged = true;
			}
			lastQueued.callback.push(callback);
		} else {
			this.queuedMessages.push(new PendingMessage(msg, callback));
		}
	};

	ConnectionManager.prototype.sendQueuedMessages = function() {
		Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.sendQueuedMessages()', 'sending ' + this.queuedMessages.length + ' queued messages');
		var pendingMessage;
		while(pendingMessage = this.queuedMessages.shift())
			this.sendImpl(pendingMessage);
	};

	ConnectionManager.prototype.queuePendingMessages = function() {
		Logger.logAction(Logger.LOG_MICRO, 'ConnectionManager.queuePendingMessages()', 'queueing ' + this.pendingMessages.length + ' pending messages');
		this.queuedMessages = this.pendingMessages.concat(this.queuedMessages);
		this.pendingMessages = [];
	};

	ConnectionManager.prototype.onChannelMessage = function(message, transport) {
		/* ignore messages received on transports that are no longer
		 * the current transport. Pending operations will have been
		 * retried when the new transport became active */
		if(transport === this.transport) {
			this.connectionSerial = message.connectionSerial;
			this.realtime.channels.onChannelMessage(message);
		}
	};

	return ConnectionManager;
})();
