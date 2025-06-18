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

const LeanEvents = require( 'nextgen-events/lib/LeanEvents.js' ) ;
const Promise = require( 'seventh' ) ;
const jsbindat = require( 'jsbindat' ) ;

const Logfella = require( 'logfella' ) ;
const log = Logfella.global.use( 'UniProtocol' ) ;



/*
	Universal UDP Protocol.
	A UDP protocol layer to simplify UDP messaging.
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
	this.ackGiveUpTimeout = + params.ackGiveUpTimeout || 2000 ;
	this.ignoreWantedAck = !! params.ignoreWantedAck ;	// true: never send ack when the other end ask for one
	this.enableSession = !! params.enableSession ;	// true: support session with handshake

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
	this.fragmentCacheTime = + params.fragmentCacheTime || 2000 ;	// How many time do we keep the fragments for re-send

	this.socket = null ;

	// Pending acks are promises, there is also a rotation between current and older, to purge old messages
	this.pendingAcks = new Map() ;
	this.olderPendingAcks = new Map() ;
}

UniProtocol.prototype = Object.create( LeanEvents.prototype ) ;
UniProtocol.prototype.constructor = UniProtocol ;

module.exports = UniProtocol ;



const UDP_IP_HEADER = 68 ;	// IP header: 60 - UDP header: 8



UniProtocol.prototype.startServer = function() {
	this.socket = dgram.createSocket( 'udp4' ) ;

	this.socket.on( 'error' , error => {
		log.error( "Socket error: %E" , error ) ;
	} ) ;

	this.socket.on( 'message' , ( message , sender ) => {
		this.receive( message , sender ) ;
	} ) ;

	this.socket.on( 'listening' , () => {
		let address = this.socket.address() ;
		log.info( "Server listening port %i" , address.port ) ;
	} ) ;

	this.socket.bind( this.serverPort ) ;
	this.pendingAcksRotation() ;
} ;



UniProtocol.prototype.startClient = function() {
	this.socket = dgram.createSocket( 'udp4' ) ;

	this.socket.on( 'error' , error => {
		log.error( "Socket error: %E" , error ) ;
	} ) ;

	this.socket.on( 'message' , ( message , sender ) => {
		this.receive( message , sender ) ;
	} ) ;

	this.pendingAcksRotation() ;
} ;



UniProtocol.prototype.pendingAcksRotation = function() {
	this.olderPendingAcks = this.pendingAcks ;
	this.pendingAcks = new Map() ;

	setTimeout( () => this.pendingAcksRotation() , this.ackGiveUpTimeout / 2 ) ;
} ;



UniProtocol.prototype.receive = function( buffer , sender ) {
	log.debug( "Received UDP packet of %iB from %s:%i => %n" , buffer.length , sender.address , sender.port , buffer ) ;
	var message = Message.decode( buffer , sender , this.protocolSignature , this.supportedCommands ) ;
	if ( ! message ) { return ; }

	log.debug( "Received UniMessage from %s:%i : %J" , sender.address , sender.port , message ) ;

	if ( ! message.isAck ) {
		this.emit( 'message' , message ) ;
		if ( message.wantAck && ! this.ignoreWantedAck ) { this.sendAckFor( message ) ; }
		return ;
	}

	let ackId = message.type + message.command + message.id ;

	let ack = this.pendingAcks.get( ackId ) ;
	if ( ack ) {
		ack.resolve() ;
		return ;
	}

	ack = this.olderPendingAcks.get( ackId ) ;
	if ( ack ) {
		ack.resolve() ;
		return ;
	}

	log.error( "Received a not wanted or forgeted ack from %s:%i (ack id: %s)" , ackId ) ;
} ;



// High-level send, manage ack and retries
UniProtocol.prototype.send = function( message , to , retries = 0 ) {
	var buffer = message.encode( this.maxPacketSize - UDP_IP_HEADER ) ;
	this.sendBuffer( buffer , to ) ;

	if ( ! message.wantAck ) { return Promise.resolved ; }

	// Ack mecanism

	let ackId = message.type + message.command + message.id ;
	let ack = new Promise() ;
	let done = false ;
	let retryTimer , timeoutTimer ;

	this.pendingAcks.set( ackId , ack ) ;

	if ( retries ) {
		retryTimer = setInterval( () => {
			if ( done ) { return ; }
			this.sendBuffer( buffer , to ) ;
			retries -- ;
			if ( retries <= 0 ) {
				if ( retryTimer ) { clearInterval( retryTimer ) ; }

				// The give up timeout only start when there is no more retry
				timeoutTimer = setTimeout( () => {
					ack.reject( new common.TimeoutError( "Ack timeout" ) ) ;
				} , this.ackGiveUpTimeout ) ;
			}
		} , this.ackResendTimeout ) ;
	}
	else {
		// The give up timeout only start when there is no more retry
		timeoutTimer = setTimeout( () => {
			ack.reject( new common.TimeoutError( "Ack timeout" ) ) ;
		} , this.ackGiveUpTimeout ) ;
	}

	ack.finally( () => {
		done = true ;
		if ( retryTimer ) { clearInterval( retryTimer ) ; }
		if ( timeoutTimer ) { clearTimeout( timeoutTimer ) ; }
	} ) ;

	return ack ;
} ;



UniProtocol.prototype.sendAckFor = function( message ) {
	var ackMessage = message.toAck() ;
	log.debug( "Sending ack to %s:%i : %s %s %i" , message.sender.address , message.sender.port , ackMessage.type , ackMessage.command , ackMessage.id ) ;
	var buffer = ackMessage.encode() ;
	this.sendBuffer( buffer , message.sender ) ;
} ;



// Low-level send
UniProtocol.prototype.sendBuffer = function( buffer , to ) {
	log.debug( "Send buffer of %iB to %s:%i => %n" , buffer.length , to.address , to.port , buffer ) ;
	this.socket.send( buffer , to.port , to.address , error => {
		if ( error ) {
			log.error( "Error sending buffer to %s:%i: %E" , to.address , to.port , error ) ;
		}
		else {
			log.debug( "Buffer of %kB sent to %s:%i => %n" , buffer.length , to.address , to.port , buffer ) ;
		}
	} ) ;
} ;



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

	message.wantAck = !! wantAck ;
	message.type = type ;
	message.command = command ;
	message.id = + id || 0 ;

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
		* 2: is ack, MUST ECHO THE SAME <type> <command name> and <ID>, and should not have data
		* 4: is nack, MUST ECHO THE SAME <type> <command name> and <ID>, should not have data, could have a fragmentIndex/fragments
		     to specify which fragment was lost
		* 8: has data, if true, data is present
		* 16: fragmented, if true, the data is fragmented, so fragmentIndex and fragments are present
		* 32: compressed data, if true, data is compressed using z-lib's deflate RAW
		* 64: encrypted, if true, data is encrypted (require a session)
		* 128: is session, if true, sessionId is present
	type: the command's type, there are 2 category of type:
		* Userland/upper-layer types:
			* C: Command, a command NOT expecting a Response, <ID> should be random
			* Q: Query, a command that expect a Response, <ID> should be random
			* R: Response, response to a commande, MUST ECHO THE SAME <command name> and <ID>
			* E: Event, send information to an eventual subscriber
		* UniProtocol built-in type of commands:
			* S: Session, start a session with a handshake (connection-like)
			* H/K: Heartbeat/Keep-alive, used to keep alive a session (connection-like)
		* Maybe:
			* F: Frame, for game or real-time app, send the current state, <ID> is the server frame number
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
	this.fragmentedData = false ;
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
}

UniProtocol.Message = Message ;



const TYPES = new Set( [ 'C' , 'Q' , 'R' , 'E' ] ) ;

const MIN_HEADER_SIZE = 15 ;
const SESSION_SIZE = 8 ;
//const MIN_FRAGMENT = MIN_HEADER_SIZE + SESSION_SIZE + 4 + 16 ;	// maxBufferSize should be at least this value, allocating at least 16 bytes to data
const MIN_DATA_FRAGMENT_SIZE = 16 ;	// maxBufferSize should at least allow 16 bytes of data

const FLAG_WANT_ACK = 1 ;
const FLAG_IS_ACK = 2 ;
const FLAG_IS_NACK = 4 ;
const FLAG_HAS_DATA = 8 ;
const FLAG_FRAGMENTED_DATA = 16 ;
const FLAG_COMPRESSED_DATA = 32 ;
const FLAG_ENCRYPTED_DATA = 64 ;
const FLAG_SESSION = 128 ;



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
	if ( ! this.dataBuffer ) { return ; }

	this.data = undefined ;
	var buffer = this.dataBuffer ;

	try {
		if ( this.compressedData ) { buffer = zlib.inflateRawSync( buffer ) ; }
		this.data = jsbindat.unserialize( buffer ) ;
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
	var buffer ;

	try {
		buffer = jsbindat.serialize( this.data ) ;
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



// Create a ack message for this message
Message.prototype.toAck = function() {
	var ackMessage = new Message() ;
	ackMessage.protocolSignature = this.protocolSignature ;
	ackMessage.isAck = true ;
	ackMessage.type = this.type ;
	ackMessage.command = this.command ;
	ackMessage.id = this.id ;
	return ackMessage ;
} ;



Message.decode = function( buffer , sender , protocolSignature , supportedCommands = null ) {

	// First, check for malformed message

	var expectedSize = MIN_HEADER_SIZE ;

	if ( buffer.length < expectedSize ) {
		log.error( "Received bad message from %s:%i (message shorter than %i)" , sender.address , sender.port , expectedSize ) ;
		return null ;
	}

	if ( buffer[ 3 ] !== 0x00 ) {
		log.error( "Received bad message from %s:%i (protocol signature does not end with 0x00)" , sender.address , sender.port ) ;
		return null ;
	}

	for ( let i = 0 ; i < 3 ; i ++ ) {
		if ( buffer[ i ] !== protocolSignature.charCodeAt( i ) ) {
			log.error( "Received bad message from %s:%i (does not start with the protocol signature: '%s')" , sender.address , sender.port , protocolSignature ) ;
			return null ;
		}
	}

	var flags = buffer.readUInt16BE( 4 ) ,
		wantAck = flags & FLAG_WANT_ACK ,
		isAck = flags & FLAG_IS_ACK ,
		isNack = flags & FLAG_IS_NACK ,
		hasData = flags & FLAG_HAS_DATA ,
		fragmentedData = flags & FLAG_FRAGMENTED_DATA ,
		compressedData = flags & FLAG_COMPRESSED_DATA ,
		encryptedData = flags & FLAG_ENCRYPTED_DATA ,
		isSession = flags & FLAG_SESSION ;

	if ( wantAck && ( isAck || isNack ) ) {
		log.error( "Received bad message from %s:%i (ack/nack should not ask for ack)" , sender.address , sender.port ) ;
		return null ;
	}

	if ( isSession ) {
		if ( this.enableSession ) {
			log.error( "Received session from %s:%i but they are disabled on this server" , sender.address , sender.port ) ;
			return null ;
		}

		expectedSize += SESSION_SIZE ;
	}

	if ( hasData ) {
		if ( isAck || isNack ) {
			log.error( "Received bad message from %s:%i (ack/nack should not contain data)" , sender.address , sender.port ) ;
			return null ;
		}

		if ( fragmentedData ) { expectedSize += 4 ; }

		if ( buffer.length <= expectedSize ) {
			// Also the data segment should have at least 1 byte
			log.error( "Received bad message from %s:%i (expecting message with data of at least %iB)" , sender.address , sender.port , expectedSize + 1 ) ;
			return null ;
		}
	}
	else {
		if ( fragmentedData || compressedData || encryptedData ) {
			log.error( "Received bad message from %s:%i (flags fragmentedData, compressedData or encryptedData cannot present without the hasData flag)" , sender.address , sender.port ) ;
			return null ;
		}

		if ( buffer.length !== expectedSize ) {
			log.error( "Received bad message from %s:%i (expecting message without data to have exactly %iB)" , sender.address , sender.port ) ;
			return null ;
		}
	}
	
	var type = String.fromCharCode( buffer[ 6 ] ) ;

	if ( ! TYPES.has( type ) ) {
		log.error( "Received bad message from %s:%i (unknown type: '%s')" , sender.address , sender.port , type ) ;
		return null ;
	}

	var command = buffer.toString( 'ascii' , 7 , 11 ) ;

	if ( supportedCommands && supportedCommands.has( command ) ) {
		log.error( "Received bad message from %s:%i (unknown command: '%s')" , sender.address , sender.port , command ) ;
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
	message.fragmentedData = !! fragmentedData ;
	message.compressedData = !! compressedData ;
	message.encryptedData = !! encryptedData ;

	var ptr = MIN_HEADER_SIZE ;

	if ( isSession ) {
		message.sessionId = buffer.toString( 'hex' , ptr , ptr + SESSION_SIZE ) ;
		ptr += SESSION_SIZE ;
	}

	if ( hasData ) {
		if ( fragmentedData ) {
			message.fragmentIndex = buffer.readUInt16BE( ptr ) ;
			message.fragments = buffer.readUInt16BE( ptr + 2 ) || 1 ;
			ptr += 4 ;
		}

		message.setDataBuffer( buffer.slice( ptr ) ) ;
	}

	return message ;
} ;



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
		//if ( this.fragmentedData ) { flags += FLAG_FRAGMENTED_DATA ; headerSize += 4 ; }
		if ( this.compressedData ) { flags += FLAG_COMPRESSED_DATA ; }
		if ( this.encryptedData ) { flags += FLAG_ENCRYPTED_DATA ; }

		// Encode data NOW: we need to know if we will fragment it
		this.encodeData() ;

		if ( maxBufferSize > 0 ) {
			if ( headerSize + this.dataBuffer.length > maxBufferSize ) {
				// We will fragment
				headerSize += 4 ;
				let maxDataSize = maxBufferSize - headerSize ;

				if ( maxDataSize <= MIN_DATA_FRAGMENT_SIZE ) {
					throw new Error( "Message#encode(): maxBufferSize is too small (" + maxBufferSize + " but the minimum is: " + ( headerSize + MIN_DATA_FRAGMENT_SIZE ) + ")" ) ;
				}

				fragments = Math.ceil( this.dataBuffer.length / maxDataSize ) ;
				fragmentSize = Math.ceil( this.dataBuffer.length / fragments ) ;
			}
		}
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

	if ( ! hasData ) { return headBuffer ; }

	if ( fragments === 1 ) {
		return Buffer.concat( [ headBuffer , this.dataBuffer ] ) ;
	}

	// Packet spliting

	let buffers = [] ;

	for ( let i = 0 ; i < fragments ; i ++ ) {
		// Write fragments
		headBuffer.writeUInt16BE( i , ptr ) ;
		headBuffer.writeUInt16BE( fragments , ptr + 2 ) ;

		let offset = fragmentSize * i ;
		buffers.push( Buffer.concat( [ headBuffer , this.dataBuffer.slice( offset , offset + fragmentSize ) ] ) ) ;
	}

	return buffers ;
} ;

