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



const UniProtocol = require( '../..' ) ;
const protocol = require( './protocol.js' ) ;

//const Promise = require( 'seventh' ) ;

const Logfella = require( 'logfella' ) ;
const log = Logfella.global.use( 'UniMaster' ) ;



function ServiceProvider( masterServerList , params = {} ) {
	// This is a server AND a client
	this.uniServer = new UniProtocol( {
		protocolSignature: 'UNM' ,
		maxPacketSize: UniProtocol.IPv4_MTU ,
		binaryDataParams: {
			perCommand: {
				Rinfo: {
					referenceStrings: true ,
					initialStringReferences: [
						'service' , 'mod' , 'protocol' , 'hasPassword' , 'humans' , 'bots' , 'maxClients'
					]
				}
			}
		}
	} ) ;

	//this.masterTimeout = + params.masterTimeout || 2000 ;
	this.masterServerList = Array.isArray( masterServerList ) ? masterServerList : [] ;
	this.info = params.info || {} ;
	this.infoChangedSinceLastNotify = true ;
	this.notifyTimer = null ;
}

module.exports = ServiceProvider ;



ServiceProvider.prototype.start = function() {
	log.info( "My IP: %s" , UniProtocol.ip.address() ) ;
	//term( "Interfaces: %Y\n" , os.networkInterfaces() ) ;

	//console.log( "UniServer:" , server ) ;

	this.uniServer.startServer() ;

	// Debug:
	this.uniServer.on( 'message' , message => { message.decodeData() ; log.info( "Received message: %s\n" , message.debugStr() ) ; } ) ;

	setTimeout( () => this.helloToMasterServers() , 50 ) ;
	this.notifyTimer = setInterval( () => this.notifyToMasterServers() , 10000 ) ;
	this.uniServer.incoming.on( 'Qinfo' , message => this.sendInfo( message ) ) ;
} ;



/*
	Set the whole server info.
*/
ServiceProvider.prototype.setInfo = function( info ) {
	if ( ! info || typeof info !== 'object' ) { return ; }
	this.info = info ;
	this.infoChangedSinceLastNotify = true ;
} ;



/*
	Update server info: update only provided keys.
*/
ServiceProvider.prototype.updateInfo = function( info ) {
	if ( ! info || typeof info !== 'object' ) { return ; }
	Object.assign( this.info , info ) ;
	this.infoChangedSinceLastNotify = true ;
} ;



/*
	Send a server info to a client.
*/
ServiceProvider.prototype.sendInfo = function( message ) {
	log.hdebug( "Received %s => sending info %n" , message.debugStr() , this.info ) ;
	this.uniServer.sendResponseFor( message , this.info ) ;
} ;



/*
	Notify master servers (Hello or Heartbeat, based on .infoChangedSinceLastNotify).
*/
ServiceProvider.prototype.notifyToMasterServers = function() {
	if ( this.infoChangedSinceLastNotify ) { return this.helloToMasterServers() ; }
	this.heartbeatToMasterServers() ;
} ;



/*
	Notify master servers (Hello).
*/
ServiceProvider.prototype.helloToMasterServers = function() {
	for ( let server of this.masterServerList ) {
		log.hdebug( "Send hello to %n" , server ) ;
		this.uniServer.sendHello( server , 'helo' ) ;
	}

	this.infoChangedSinceLastNotify = false ;
} ;



/*
	Notify master servers (Heartbeat).
*/
ServiceProvider.prototype.heartbeatToMasterServers = function() {
	for ( let server of this.masterServerList ) {
		log.hdebug( "Send heartbeat to %n" , server ) ;
		this.uniServer.sendKeepAlive( server , 'hrtb' ) ;
	}

	this.infoChangedSinceLastNotify = false ;
} ;

