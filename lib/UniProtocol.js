/*
	UniProtocol

	Copyright (c) 2025 Cédric Ronvel

	The MIT License (MIT)

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
*/

"use strict" ;



const common = require( './common.js' ) ;

const dgram = require( 'dgram' ) ;
const zlib = require( 'zlib' ) ;

const ip = require( 'ip' ) ;

const LeanEvents = require( 'nextgen-events/lib/LeanEvents.js' ) ;
const Promise = require( 'seventh' ) ;
const jsbindat = require( 'jsbindat' ) ;
const lruKit = require( 'lru-kit' ) ;

const Logfella = require( 'logfella' ) ;
const log = Logfella.global.use( 'UniProtocol' ) ;



/*
	Universal UDP Protocol.
	A UDP protocol layer to simplify UDP messaging.
	
	Support: ack, deflate compression, packet fragmentation/reassembly.
	TODO: nack, session, encryption.
*/
function UniProtocol( params = {} ) {
	this.protocolSignature = 'UNP' ;
	this.serverPort = + params.serverPort || 0 ;	// If set, start listening to this port
	this.autoUnserialize = !! params.autoUnserialize ;
	this.supportedCommands =
		Array.isArray( params.supportedCommands ) ? new Set( params.supportedCommands ) :
		params.supportedCommands instanceof Set ? new Set( params.supportedCommands ) :
		null ;

	this.ackResendTimeout = + params.ackResendTimeout || 200 ;
	this.ackForgetTimeout = + params.ackForgetTimeout || 2000 ;
	this.ignoreWantedAck = !! params.ignoreWantedAck ;	// true: never send ack when the other end ask for one
	this.enableSession = !! params.enableSession ;	// true: support session with handshake

	// Data serializer parameters (jsbindat), allowing more space-efficient serialization (e.g. when using a data model)
	// this.binaryDataParams.global contains global config, this.binaryDataParams.perCommand contains per-command config (key: type + command)
	this.binaryDataParams = params.binaryDataParams || null ;

	if ( params.protocolSignature ) {
		if ( typeof params.protocolSignature === 'string' && params.protocolSignature.length === 3 && params.protocolSignature.match( /^[a-z-A-Z0-9]{3}$/ ) ) {
			this.protocolSignature = params.protocolSignature ;
		}
		else {
			throw new Error( "Optional parameter 'protocolSignature' MUST BE a 3 alpha-numeric string if defined" ) ;
		}
	}

	/*
		If maxPacketSize is non-zero, this is the max packet size allowed, it's usually best to set it to the MTU, if known.

		For IPv4 MTU = 576, for IPv6 MTU = 1280.
		So a "safe" maximum UDP packet size for IPv4 is 576 - 60 (IP header) - 8 (UDP header) = 508.
		For IPv6, it's 1280 - 60 - 8 = 1212.
		If a packet is bigger, it will be fragmented.
		Fragmentation is invisible, packet are reassembled, but if one fragment is lost, the whole packet is lost,
		so the chance that a big packet will be dropped by a router increases dramatically.

		So, instead of relying on the IP fragmentation, we implement fragmentation on our own.
		Any payload producing packet bigger than that limit will be fragmented on our side, because we can handle packet
		lost more efficiently this way, by just sending the missing part.
	*/
	this.maxPacketSize = + params.maxPacketSize || 0 ;
	this.reassemblyForgetTimeout = + params.reassemblyForgetTimeout || 2000 ;

	this.socket = null ;

	// Events on "this" are generic, event on .incoming are Messages, named after the message's type + command
	this.incoming = new LeanEvents() ;

	// Pending acks are promises, older pending acks are purged
	this.pendingAcks = new lruKit.LRUCacheMap( this.ackForgetTimeout , 1000 , 4 ) ;

	// Pending fragments awaiting to be reassembled, older pending fragments are purged
	this.pendingReassemblies = new lruKit.LRUCacheMap( this.reassemblyForgetTimeout , 1000 , 4 ) ;

	// Pending queries are promises, older pending queries are purged
	this.responseForgetTimeout = + params.responseForgetTimeout || 2000 ;
	this.pendingResponses = new lruKit.LRUCacheMap( this.responseForgetTimeout , 1000 , 4 ) ;

	this.serverStarted = false ;
	this.clientStarted = false ;
}

UniProtocol.prototype = Object.create( LeanEvents.prototype ) ;
UniProtocol.prototype.constructor = UniProtocol ;

module.exports = UniProtocol ;

UniProtocol.common = common ;
UniProtocol.ip = ip ;
UniProtocol.DataModel = jsbindat.DataModel ;
UniProtocol.ClassMap = jsbindat.ClassMap ;



UniProtocol.IPv4_MTU = 576 ;
UniProtocol.IPv6_MTU = 1280 ;

const UDP_IP_HEADER_SIZE = 68 ;	// IP header: 60 - UDP header: 8



UniProtocol.prototype.startServer = function() {
	if ( this.serverStarted ) { return ; }
	this.serverStarted = true ;

	this.socket = dgram.createSocket( 'udp4' ) ;

	this.socket.on( 'error' , error => {
		log.error( "Socket error: %E" , error ) ;
	} ) ;

	this.socket.on( 'message' , ( message , sender ) => {
		this.receive( sender , message ) ;
	} ) ;

	this.socket.on( 'listening' , () => {
		let address = this.socket.address() ;
		log.info( "Server listening port %i" , address.port ) ;
	} ) ;

	this.socket.bind( this.serverPort ) ;
} ;



UniProtocol.prototype.startClient = function() {
	if ( this.clientStarted ) { return ; }
	this.clientStarted = true ;

	this.socket = dgram.createSocket( 'udp4' ) ;

	this.socket.on( 'error' , error => {
		log.error( "Socket error: %E" , error ) ;
	} ) ;

	this.socket.on( 'message' , ( message , sender ) => {
		this.receive( sender , message ) ;
	} ) ;
} ;



// Discover a service on a local network, scan 192.168.x.y, x from our own IP, and y going from 2 to 254.
// Only work for IPv4 at the moment.
// endPort is included.
UniProtocol.prototype.discover = async function( startPort , endPort = startPort ) {
	var myIp = ip.address() ;
	log.info( "My IP: %s" , myIp ) ;

	if ( ! myIp.startsWith( '192.168.' ) ) {
		// No local network ip found
		return null ;
	}

	var match = myIp.match( /(^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.)[0-9]{1,3}$/ ) ;
	var ipPrefix = match[ 1 ] ;
	var list = [] ;

	for ( let lastPart = 2 ; lastPart <= 254 ; lastPart ++ ) {
		for ( let port = startPort ; port <= endPort ; port ++ ) {
			list.push( { address: ipPrefix + lastPart , port } ) ;
		}
	}

	//var responses = await Promise.concurrent( 50 , list , dest => {
	var responses = await Promise.map( list , dest => {
		let message = this.createMessageWithAck( 'h' , 'helo' ) ;
		return this.send( dest , message ).then( () => dest ).catch( () => null ) ;
	} ) ;

	return responses.filter( v => v ) ;
} ;



UniProtocol.prototype.receive = function( sender , buffer ) {
	log.debug( "Received UDP packet of %iB from %s:%i => %n" , buffer.length , sender.address , sender.port , buffer ) ;
	var message = Message.decode( buffer , sender , this.protocolSignature , this.supportedCommands , this.binaryDataParams ) ;
	if ( ! message ) { return ; }

	log.debug( "Received %Y" , message ) ;

	if ( message.isAck ) {
		let ackId = message.getAckId() ;
		let ack = this.pendingAcks.get( ackId ) ;

		if ( ack ) {
			log.debug( "Received ack %s" , ackId ) ;

			// Useful to delete it? Probably for security reason to detect bad endpoint.
			// For instance it's useless.
			this.pendingAcks.delete( ackId ) ;
			ack.resolve() ;
		}
		else {
			log.error( "Received a not wanted or forgotten ack %s" , ackId ) ;
		}

		return ;
	}

	if ( message.wantAck && ! this.ignoreWantedAck ) {
		this.sendAckFor( message ) ;
	}

	if ( ! message.fragmented ) {
		this.receiveFullMessage( message ) ;
		return ;
	}

	let reassemblyId = message.getReassemblyId() ;
	let reassembly = this.pendingReassemblies.get( reassemblyId ) ;
	if ( ! reassembly ) {
		reassembly = new Array( message.fragments ) ;
		reassembly.fill( null ) ;
		this.pendingReassemblies.set( reassemblyId , reassembly ) ;
	}

	if ( message.fragmentIndex >= reassembly.length ) {
		log.error( "Received a fragment with index too big (%i/%i, reassembly id: %s)" , message.fragmentIndex , reassembly.length , reassemblyId ) ;
		return ;
	}

	reassembly[ message.fragmentIndex ] = message ;

	// If not all fragments are retrieved, there is nothing to do at the moment...
	if ( ! reassembly.every( v => v ) ) { return ; }

	let reassembledMessage = Message.reassemble( reassembly ) ;
	this.receiveFullMessage( reassembledMessage ) ;
} ;



// Called when the full message is received (after reassembly for fragmented message)
UniProtocol.prototype.receiveFullMessage = function( message ) {
	if ( message.type === 'R' ) {
		let responseId = message.getResponseId() ;
		//log.hdebug( "Searching response %s" , responseId ) ;
		let responsePromise = this.pendingResponses.get( responseId ) ;

		if ( responsePromise ) {
			log.debug( "Received response %s" , responseId ) ;
			this.pendingResponses.delete( responseId ) ;
			responsePromise.resolve( message ) ;
		}
		else {
			log.error( "Received a not wanted or forgotten response %s" , responseId ) ;
		}
	}

	this.emit( 'message' , message ) ;
	this.incoming.emit( message.type + message.command , message ) ;
} ;



// High-level send of type 'C' (command), manage retries.
UniProtocol.prototype.sendCommand = async function( to , command , data = undefined , options = null ) {
	var id = common.getPseudoRandomUInt32() ;
	var message = this._createMessage( !! options?.ack , 'C' , command , id , data , !! options?.compressed ) ;
	return this.sendMessage( to , message , options?.retries || 0 ) ;
} ;



// High-level send of type 'H' (hello), manage retries.
UniProtocol.prototype.sendHello = async function( to , command , data = undefined , options = null ) {
	var id = common.getPseudoRandomUInt32() ;
	var message = this._createMessage( !! options?.ack , 'H' , command , id , data , !! options?.compressed ) ;
	return this.sendMessage( to , message , options?.retries || 0 ) ;
} ;



// High-level send of type 'K' (keep-alive, heartbeat), manage retries.
// /!\ Maybe there is few difference here, do we need acks and retries? Should the id be incremental or always 0?
UniProtocol.prototype.sendKeepAlive = async function( to , command , data = undefined , options = null ) {
	var id = common.getPseudoRandomUInt32() ;
	var message = this._createMessage( !! options?.ack , 'K' , command , id , data , !! options?.compressed ) ;
	return this.sendMessage( to , message , options?.retries || 0 ) ;
} ;



// High-level send of type 'Q' (query), manage retries.
// While ack may seem useless because Query expect a Response, a fragmented Query may benefit from acks.
UniProtocol.prototype.sendQuery = async function( to , command , data = undefined , options = null ) {
	var id = common.getPseudoRandomUInt32() ;
	var message = this._createMessage( !! options?.ack , 'Q' , command , id , data , !! options?.compressed ) ;
	await this.sendMessage( to , message , options?.retries || 0 ) ;

	// Response mecanism

	let responseId = message.getResponseId( to ) ;
	let retries = options?.retries || 0 ;
	let responsePromise = new Promise() ;
	let done = false ;
	let retryTimer = null ;
	let timeoutTimer = null ;

	//log.hdebug( "Add %s to the pending responses" , responseId ) ;
	this.pendingResponses.set( responseId , responsePromise ) ;

	timeoutTimer = setTimeout( () => {
		responsePromise.reject( new common.TimeoutError( "Response timeout" ) ) ;
	} , this.responseForgetTimeout ) ;

	responsePromise.finally( () => {
		if ( timeoutTimer ) { clearTimeout( timeoutTimer ) ; timeoutTimer = null ; }
	} ) ;

	return responsePromise ;
} ;



// High-level send of type 'R' (or any response's types) for a specific query (or any query's types), manage retries.
UniProtocol.prototype.sendResponseFor = async function( forMessage , data = undefined , options = null ) {
	if ( ! Object.hasOwn( RESPONSE_TYPE_FOR , forMessage.type ) ) {
		throw new Error( "Can't send response for a message of type: '" + forMessage.type + "'." ) ;
	}

	var message = this._createMessage( !! options?.ack , RESPONSE_TYPE_FOR[ forMessage.type ] , forMessage.command , forMessage.id , data , !! options?.compressed ) ;
	return this.sendMessage( forMessage.sender , message , options?.retries || 0 ) ;
} ;



// Low-level send, manage ack and retries
UniProtocol.prototype.sendMessage = function( to , message , retries = 0 ) {
	var buffers = message.encode( this.maxPacketSize - UDP_IP_HEADER_SIZE ) ;

	if ( buffers.length === 1 ) {
		return this.sendFragment( to , message , 0 , buffers[ 0 ] , retries ) ;
	}

	log.hdebug( "Fragmented! %i" , buffers.length ) ;
	return Promise.map( buffers , ( buffer , fragmentIndex ) => this.sendFragment( to , message , fragmentIndex , buffer , retries ) ) ;
} ;



// Internal
UniProtocol.prototype.sendFragment = async function( to , message , fragmentIndex , buffer , retries = 0 ) {
	await this.sendBuffer( to , buffer ) ;

	if ( ! message.wantAck ) { return ; }

	// Ack mecanism

	let ackId = message.getAckId( to , fragmentIndex ) ;
	let ack = new Promise() ;
	let done = false ;
	let retryTimer = null ;
	let timeoutTimer = null ;

	this.pendingAcks.set( ackId , ack ) ;

	if ( retries ) {
		let retryFn = async () => {
			retryTimer = null ;
			if ( done ) { return ; }
			await this.sendBuffer( to , buffer ) ;
			retries -- ;
			if ( retries > 0 ) { retryTimer = setTimeout( retryFn , this.ackResendTimeout ) ; }
		} ;

		retryTimer = setTimeout( retryFn , this.ackResendTimeout ) ;
	}

	timeoutTimer = setTimeout( () => {
		ack.reject( new common.TimeoutError( "Ack timeout" ) ) ;
	} , this.ackForgetTimeout ) ;

	ack.finally( () => {
		done = true ;
		if ( retryTimer ) { clearTimeout( retryTimer ) ; retryTimer = null ; }
		if ( timeoutTimer ) { clearTimeout( timeoutTimer ) ; timeoutTimer = null ; }
	} ) ;

	return ack ;
} ;



// Internal
UniProtocol.prototype.sendAckFor = function( message ) {
	var ackMessage = message.toAck() ;
	log.debug( "Sending ack %s" , ackMessage.getAckId( message.sender ) ) ;
	var buffers = ackMessage.encode() ;
	this.sendBuffer( message.sender , buffers[ 0 ] ) ;
} ;



// Internal
UniProtocol.prototype.sendBuffer = function( to , buffer ) {
	var promise = new Promise() ;
	log.debug( "Send buffer of %iB to [%s]:%i => %n" , buffer.length , to.address , to.port , buffer ) ;
	this.socket.send( buffer , to.port , to.address , error => {
		if ( error ) {
			// Not sure if it's good to reject here...
			log.error( "Error sending buffer to [%s]:%i: %E" , to.address , to.port , error ) ;
			//promise.reject( error ) ;
			promise.resolve() ;
		}
		else {
			log.debug( "Buffer of %iB sent to [%s]:%i => %n" , buffer.length , to.address , to.port , buffer ) ;
			promise.resolve() ;
		}
	} ) ;

	return promise ;
} ;



// Low-level or internal
UniProtocol.prototype.createMessage = function( type , command , id = 0 , data = undefined , compressed = false ) {
	return this._createMessage( false , type , command , id , data , compressed ) ;
} ;

UniProtocol.prototype.createMessageWithAck = function( type , command , id = 0 , data = undefined , compressed = false ) {
	return this._createMessage( true , type , command , id , data , compressed ) ;
} ;

UniProtocol.prototype._createMessage = function( wantAck , type , command , id , data , compressed ) {
	if ( typeof type !== 'string' || type.length !== 1 || typeof command !== 'string' || command.length !== 4 ) {
		throw new Error( ".createMessage(): type and command argument must be string of length 1 and 4" ) ;
	}

	var message = new Message() ;

	message.protocolSignature = this.protocolSignature ;
	message.wantAck = !! wantAck ;
	message.type = type ;
	message.command = command ;
	message.id = + id || 0 ;
	message.binaryDataParams = this.binaryDataParams ;

	if ( data !== undefined ) {
		message.setData( data ) ;
		message.compressedData = !! compressed ;
	}

	return message ;
} ;



/*
	Low level UDP, mandatory blocks:
	<proto-signature>(ascii 3) 0x00 <flags>(uint16 2) <type>(ascii 1) <command>(ascii 4) <ID>(uint32 4)
	
	Optional blocks:
		<sessionId>(buffer 8? 12? 16?)
		<fragment index>(uint16 2) <fragments>(uint16 2)
		<jsbindat data>(bin any)

	flags:
		* 1: require ack, the recipient is supposed to send back a ack, the sender could resend the message until the ack is received
		* 2: is ack, MUST ECHO THE SAME <type> <command name> and <ID>, and should not have data, and also fragmentIndex/fragments
		     if the fragmented flag is set
		* 4: is nack, MUST ECHO THE SAME <type> <command name> and <ID>, should not have data, could have a fragmentIndex/fragments
		     to specify which fragment was lost
		* 8: has data, if true, data is present
		* 16: fragmented, if true, the data is fragmented, so fragmentIndex and fragments are present
		* 32: compressed data, if true, data is compressed using z-lib's deflate RAW
		* 64: encrypted, if true, data is encrypted (require a session)
		* 128: is session, if true, sessionId is present
	type: the command's type, there are 2 category of type:
		* Userland/upper-layer types (uppercase letter because of "high-level"):
			* C: Command, a command NOT expecting a Response, <ID> should be random
			* Q: Query, a command that expect a Response, <ID> should be random
			* R: Response, response to a query, MUST ECHO THE SAME <command name> and <ID>
			* E: Event, send information to an eventual subscriber
			* K: userland Keep-alive/Heartbeat
			* H: userland Hello
		* Maybe:
			* F: Frame, for game or real-time app, send the current state, <ID> is the server frame number
			* S: userland session
		* UniProtocol built-in type of commands (lowercase letter because of "low-level") (TODO):
			* k: Keep-alive/Heartbeat, used to keep alive a session (connection-like, or just to keep the NAT rule on)
			* h: Hello, used to discover services
			* s: Session, start a session with a handshake (connection-like)
	command: userland, any 4 ascii alpha-numeric command
	id: an uint32 used as ID for a command, could be auto-incremented or random, it identify a command when it have to be sent again
	fragments: how many fragments (packets) the data payload is splitted into, with the 490B data limit per fragment
		(due to MTU, it is best to have UDP packets up to 508B for IPv4), it allows up to 32MB of data
	fragmentIndex: the current fragment, from 0 to fragments - 1
	data: serialized data using jsbindat
*/

function Message() {
	this.sender = null ;
	this.protocolSignature = 'UNP' ;
	this.wantAck = false ;
	this.isAck = false ;
	this.isNack = false ;
	this.fragmented = false ;	// for a fragment, more fragments have to be received to reassemble the full message, also set for fragment ack
	this.reassembled = false ;	// this is not an original message, but a message reassembled from multiple fragments
	this.compressedData = false ;	// compressed using deflat RAW
	this.encryptedData = false ;	// require a sessionId
	this.type = '' ;
	this.command = '' ;
	this.id = 0 ;
	this.sessionId = null ;	// if set, it is a hex string/or a buffer???
	this.fragmentIndex = 0 ;
	this.fragments = 1 ;

	this.dataBuffer = null ;
	this.data = undefined ;
	this.encoded = false ;
	this.decoded = false ;

	this.binaryDataParams = null ;
}

UniProtocol.Message = Message ;



const TYPES = new Set( [
	'C' , 'Q' , 'R' , 'E' , 'K' , 'H' ,
	'h'
] ) ;

const MIN_HEADER_SIZE = 15 ;
const SESSION_SIZE = 8 ;
//const MIN_FRAGMENT = MIN_HEADER_SIZE + SESSION_SIZE + 4 + 16 ;	// maxBufferSize should be at least this value, allocating at least 16 bytes to data
const MIN_DATA_FRAGMENT_SIZE = 16 ;	// maxBufferSize should at least allow 16 bytes of data

const FLAG_WANT_ACK = 1 ;
const FLAG_IS_ACK = 2 ;
const FLAG_IS_NACK = 4 ;
const FLAG_HAS_DATA = 8 ;
const FLAG_FRAGMENTED = 16 ;
const FLAG_COMPRESSED_DATA = 32 ;
const FLAG_ENCRYPTED_DATA = 64 ;
const FLAG_SESSION = 128 ;



// Create a ack message for this message
Message.prototype.toAck = function() {
	var ackMessage = new Message() ;

	ackMessage.protocolSignature = this.protocolSignature ;
	ackMessage.isAck = true ;
	ackMessage.type = this.type ;
	ackMessage.command = this.command ;
	ackMessage.id = this.id ;

	if ( this.fragmented ) {
		ackMessage.fragmented = true ;
		ackMessage.fragmentIndex = this.fragmentIndex ;
		ackMessage.fragments = this.fragments ;
	}

	return ackMessage ;
} ;



// We can force a fragment index, because when fragmenting a message, we just encode into multiple buffers,
// we do not create multiple messages, so we need to overide it.
Message.prototype.getAckId = function( endpoint = this.sender , fragmentIndex = this.fragmentIndex ) {
	var ackId = '[' + endpoint.address + ']:' + endpoint.port + ':' + this.type + this.command + this.id ;

	if ( this.fragmented ) {
		ackId += ':' + fragmentIndex + '/' + this.fragments ;
	}

	return ackId ;
} ;



const RESPONSE_TYPE_FOR = {
	Q: 'R' ,
	q: 'r'
} ;

Message.prototype.getResponseId = function( endpoint = this.sender ) {
	var responseType = Object.hasOwn( RESPONSE_TYPE_FOR , this.type ) ? RESPONSE_TYPE_FOR[ this.type ] : this.type ;
	return '[' + endpoint.address + ']:' + endpoint.port + ':' + responseType + this.command + this.id ;
} ;



Message.reassemble = function( messageList ) {
	var first = messageList[ 0 ] ,
		reassembledMessage = new Message() ;

	reassembledMessage.reassembled = true ;
	reassembledMessage.sender = first.sender ;
	reassembledMessage.protocolSignature = first.protocolSignature ;
	reassembledMessage.type = first.type ;
	reassembledMessage.command = first.command ;
	reassembledMessage.id = first.id ;
	reassembledMessage.compressedData = first.compressedData ;
	reassembledMessage.encryptedData = first.encryptedData ;
	reassembledMessage.sessionId = first.sessionId ;
	reassembledMessage.binaryDataParams = first.binaryDataParams ;

	// Now concat all data buffers
	log.hdebug( "Message.reassemble(): %Y" , messageList.map( message => message.dataBuffer ) ) ;
	reassembledMessage.dataBuffer = Buffer.concat( messageList.map( message => message.dataBuffer ) ) ;

	return reassembledMessage ;
} ;



Message.prototype.getReassemblyId = function( endpoint = this.sender ) {
	return '[' + endpoint.address + ']:' + endpoint.port + ':' + this.type + this.command + this.id + '/' + this.fragments ;
} ;



Message.prototype.setData = function( data ) {
	this.data = data ;
	this.decoded = true ;
	this.dataBuffer = null ;
	this.encoded = false ;
} ;



Message.prototype.setDataBuffer = function( dataBuffer ) {
	this.dataBuffer = dataBuffer ;
	this.encoded = true ;
	this.data = undefined ;
	this.decoded = false ;
} ;



// Free some space
Message.prototype.clearDataBuffer = function() {
	this.dataBuffer = null ;
	this.encoded = false ;
} ;



Message.prototype.decodeData = function() {
	if ( this.decoded ) { return this.data ; }
	if ( ! this.dataBuffer || this.fragmented ) { return ; }

	this.data = undefined ;

	var buffer = this.dataBuffer ,
		binaryDataParams = this.binaryDataParams?.perCommand?.[ this.type + this.command ] ?? this.binaryDataParams?.global ;
	if ( binaryDataParams ) { log.hdebug( "binaryDataParams: %Y" , binaryDataParams ) ; }
	log.hdebug( "binaryDataParams: %Y" , this.binaryDataParams ) ;

	try {
		if ( this.compressedData ) { buffer = zlib.inflateRawSync( buffer ) ; }
		this.data = jsbindat.unserialize( buffer , binaryDataParams ) ;
	}
	catch ( error ) {
		log.error( "Can't decode data: %E" , error ) ;
		return ;
	}

	this.decoded = true ;

	return this.data ;
} ;



Message.prototype.encodeData = function() {
	if ( this.encoded ) { return this.dataBuffer ; }

	this.dataBuffer = null ;

	var buffer ,
		binaryDataParams = this.binaryDataParams?.perCommand?.[ this.type + this.command ] ?? this.binaryDataParams?.global ;
	if ( binaryDataParams ) { log.hdebug( "binaryDataParams: %Y" , binaryDataParams ) ; }
	log.hdebug( "binaryDataParams: %Y" , this.binaryDataParams ) ;

	try {
		buffer = jsbindat.serialize( this.data , binaryDataParams ) ;
		if ( this.compressedData ) { buffer = zlib.deflateRawSync( buffer ) ; }
	}
	catch ( error ) {
		log.error( "Can't encode data: %E" , error ) ;
		return null ;
	}

	this.dataBuffer = buffer ;
	this.encoded = true ;

	return this.dataBuffer ;
} ;



Message.decode = function( buffer , sender , protocolSignature , supportedCommands = null , binaryDataParams = null ) {

	// First, check for malformed message

	var expectedSize = MIN_HEADER_SIZE ;

	if ( buffer.length < expectedSize ) {
		log.error( "Received bad message from [%s]:%i (message shorter than %i)" , sender.address , sender.port , expectedSize ) ;
		return null ;
	}

	if ( buffer[ 3 ] !== 0x00 ) {
		log.error( "Received bad message from [%s]:%i (protocol signature does not end with 0x00)" , sender.address , sender.port ) ;
		return null ;
	}

	for ( let i = 0 ; i < 3 ; i ++ ) {
		if ( buffer[ i ] !== protocolSignature.charCodeAt( i ) ) {
			log.error( "Received bad message from [%s]:%i (does not start with the protocol signature: '%s')" , sender.address , sender.port , protocolSignature ) ;
			return null ;
		}
	}

	var flags = buffer.readUInt16BE( 4 ) ,
		wantAck = flags & FLAG_WANT_ACK ,
		isAck = flags & FLAG_IS_ACK ,
		isNack = flags & FLAG_IS_NACK ,
		hasData = flags & FLAG_HAS_DATA ,
		fragmented = flags & FLAG_FRAGMENTED ,
		compressedData = flags & FLAG_COMPRESSED_DATA ,
		encryptedData = flags & FLAG_ENCRYPTED_DATA ,
		isSession = flags & FLAG_SESSION ;

	if ( wantAck && ( isAck || isNack ) ) {
		log.error( "Received bad message from [%s]:%i (ack/nack should not ask for ack)" , sender.address , sender.port ) ;
		return null ;
	}

	if ( isSession ) {
		if ( this.enableSession ) {
			log.error( "Received session from [%s]:%i but they are disabled on this server" , sender.address , sender.port ) ;
			return null ;
		}

		expectedSize += SESSION_SIZE ;
	}

	if ( fragmented ) { expectedSize += 4 ; }

	if ( hasData ) {
		if ( isAck || isNack ) {
			log.error( "Received bad message from [%s]:%i (ack/nack should not contain data)" , sender.address , sender.port ) ;
			return null ;
		}

		if ( buffer.length <= expectedSize ) {
			// Also the data segment should have at least 1 byte
			log.error( "Received bad message from [%s]:%i (expecting message with data of at least %iB)" , sender.address , sender.port , expectedSize + 1 ) ;
			return null ;
		}
	}
	else {
		if ( compressedData || encryptedData ) {
			log.error( "Received bad message from [%s]:%i (flags fragmented, compressedData or encryptedData cannot be present without the hasData flag)" , sender.address , sender.port ) ;
			return null ;
		}

		if ( buffer.length !== expectedSize ) {
			log.error( "Received bad message from [%s]:%i (expecting message without data to have exactly %iB)" , sender.address , sender.port ) ;
			return null ;
		}
	}
	
	var type = String.fromCharCode( buffer[ 6 ] ) ;

	if ( ! TYPES.has( type ) ) {
		log.error( "Received bad message from [%s]:%i (unknown type: '%s')" , sender.address , sender.port , type ) ;
		return null ;
	}

	var command = buffer.toString( 'ascii' , 7 , 11 ) ;

	if ( supportedCommands && supportedCommands.has( command ) ) {
		log.error( "Received bad message from [%s]:%i (unknown command: '%s')" , sender.address , sender.port , command ) ;
		return null ;
	}

	// Now we have a rather good message, except maybe in the serialized data (but they are lazy-unserialized)

	var message = new Message() ;

	message.sender = sender ;
	message.protocolSignature = protocolSignature ;
	message.type = type ;
	message.command = command ;
	message.id = buffer.readUInt32BE( 11 ) ;
	message.wantAck = !! wantAck ;
	message.isAck = !! isAck ;
	message.isNack = !! isNack ;
	message.fragmented = !! fragmented ;
	message.compressedData = !! compressedData ;
	message.encryptedData = !! encryptedData ;
	message.binaryDataParams = binaryDataParams ;


	var ptr = MIN_HEADER_SIZE ;

	if ( isSession ) {
		message.sessionId = buffer.toString( 'hex' , ptr , ptr + SESSION_SIZE ) ;
		ptr += SESSION_SIZE ;
	}

	if ( fragmented ) {
		// fragmented can be set without data: for Ack and Nack
		message.fragmentIndex = buffer.readUInt16BE( ptr ) ;
		message.fragments = buffer.readUInt16BE( ptr + 2 ) || 1 ;
		ptr += 4 ;
	}

	if ( hasData ) {
		message.setDataBuffer( buffer.slice( ptr ) ) ;
	}

	return message ;
} ;



// Return an array of buffers
Message.prototype.encode = function( maxBufferSize = 0 ) {
	var headerSize = MIN_HEADER_SIZE ,
		hasData = false ,
		flags = 0 ,
		fragments = 1 ,
		fragmentSize = 0 ;

	if ( this.wantAck ) { flags += FLAG_WANT_ACK ; }
	if ( this.isAck ) { flags += FLAG_IS_ACK ; }
	if ( this.isNack ) { flags += FLAG_IS_NACK ; }
	if ( this.sessionId ) { flags += FLAG_SESSION ; headerSize += SESSION_SIZE ; }

	if ( this.data !== undefined ) {
		flags += FLAG_HAS_DATA ;
		hasData = true ;
		//if ( this.fragmented ) { flags += FLAG_FRAGMENTED ; headerSize += 4 ; }
		if ( this.compressedData ) { flags += FLAG_COMPRESSED_DATA ; }
		if ( this.encryptedData ) { flags += FLAG_ENCRYPTED_DATA ; }

		// Encode data NOW: we need to know if we will fragment it
		this.encodeData() ;

		log.hdebug( "Max buffer size: %iB" , maxBufferSize ) ;
		if ( maxBufferSize > 0 ) {
			log.hdebug( "Packet size: %i + %i = %iB" , headerSize , this.dataBuffer.length , headerSize + this.dataBuffer.length ) ;
			if ( headerSize + this.dataBuffer.length > maxBufferSize ) {
				log.hdebug( "Will fragment!" ) ;
				// Mark as fragmented
				this.fragmented = true ;
				flags += FLAG_FRAGMENTED ;
				headerSize += 4 ;

				let maxDataSize = maxBufferSize - headerSize ;

				if ( maxDataSize <= MIN_DATA_FRAGMENT_SIZE ) {
					throw new Error( "Message#encode(): maxBufferSize is too small (" + maxBufferSize + " but the minimum is: " + ( headerSize + MIN_DATA_FRAGMENT_SIZE ) + ")" ) ;
				}

				this.fragments = fragments = Math.ceil( this.dataBuffer.length / maxDataSize ) ;
				fragmentSize = Math.ceil( this.dataBuffer.length / fragments ) ;
			}
		}
	}
	else if ( this.fragmented && ( this.isAck || this.isNack ) ) {
		flags += FLAG_FRAGMENTED ;
		headerSize += 4 ;
	}

	let headBuffer = Buffer.allocUnsafe( headerSize ) ;
	headBuffer.write( this.protocolSignature , 0 , 3 , 'ascii' ) ;
	headBuffer[ 3 ] = 0x00 ;
	headBuffer.writeUInt16BE( flags , 4 ) ;
	headBuffer.write( this.type , 6 , 7 , 'ascii' ) ;
	headBuffer.write( this.command , 7 , 11 , 'ascii' ) ;
	headBuffer.writeUInt32BE( this.id , 11 ) ;

	let ptr = MIN_HEADER_SIZE ;

	if ( this.sessionId ) {
		headBuffer.write( this.sessionId , ptr , SESSION_SIZE , 'hex' ) ;
		ptr += SESSION_SIZE ;
	}

	if ( this.fragmented && ( this.isAck || this.isNack ) ) {
		// Do not write actual fragments, but this.fragments
		headBuffer.writeUInt16BE( this.fragmentIndex , ptr ) ;
		headBuffer.writeUInt16BE( this.fragments , ptr + 2 ) ;
	}

	if ( ! hasData ) { return [ headBuffer ] ; }

	if ( fragments === 1 ) {
		return [ Buffer.concat( [ headBuffer , this.dataBuffer ] ) ] ;
	}

	// Packet spliting

	headBuffer.writeUInt16BE( fragments , ptr + 2 ) ;

	let buffers = [] ;

	for ( let i = 0 ; i < fragments ; i ++ ) {
		// Write fragment index
		headBuffer.writeUInt16BE( i , ptr ) ;

		let offset = fragmentSize * i ;
		buffers.push( Buffer.concat( [ headBuffer , this.dataBuffer.slice( offset , offset + fragmentSize ) ] ) ) ;
	}

	return buffers ;
} ;



Message.prototype.debugStr = function() {
	var parts = [] ;

	parts.push( this.protocolSignature + '://' + this.type + '/' + this.command + '/' + this.id ) ;

	if ( this.sender ) { parts.push( 'from: [' + this.sender.address + ']:' + this.sender.port ) ; }

	var flags = '' ;
	if ( this.wantAck ) { flags += ' wA' ; }
	if ( this.isAck ) { flags += ' A' ; }
	if ( this.isNack ) { flags += ' nA' ; }
	if ( this.fragmented ) { flags += ' frg' ; }
	if ( this.reassembled ) { flags += ' rasm' ; }	// pseudo-flag
	if ( this.compressedData ) { flags += ' cmpr' ; }
	if ( this.encryptedData ) { flags += ' enc' ; }
	parts.push( 'flags:' + ( flags || ' none' ) ) ;

	if ( this.sessionId ) { parts.push( 'sessionId: ' + this.sessionId ) ; }
	if ( this.fragments > 1 ) { parts.push( 'fragment: ' + this.fragmentIndex + '/' + this.fragments ) ; }

	if ( this.data ) { parts.push( 'data: ' + JSON.stringify( this.data ) ) ; }
	else if ( this.dataBuffer ) { parts.push( 'dataBuffer: ' + this.dataBuffer.inspect() ) ; }

	return parts.join( ', ' ) ;
}



Message.prototype.inspect = function() {
	return '<UniMessage ' + this.debugStr() + '>' ;
} ;

