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



function MasterServer( params ) {
	this.uniServer = new UniProtocol( {
		protocolSignature: 'UNM' ,
		serverPort: params.port || 1234 ,
		maxPacketSize: UniProtocol.IPv4_MTU ,
		binaryDataParams: {
			perCommand: {
				Rserv: {
					model: protocol.serverList
				} ,
				Rinfo: {
					referenceStrings: true ,
					initialStringReferences: [
						'service' , 'mod' , 'protocol' , 'hasPassword' , 'humans' , 'bots' , 'maxClients'
					]
				}
			}
		}
	} ) ;

	this.serverMap = new Map() ;
}

module.exports = MasterServer ;



MasterServer.prototype.start = function() {
	log.info( "My IP: %s" , UniProtocol.ip.address() ) ;
	//term( "Interfaces: %Y\n" , os.networkInterfaces() ) ;

	//console.log( "UniServer:" , server ) ;

	this.uniServer.startServer() ;

	// Debug:
	this.uniServer.on( 'message' , message => { message.decodeData() ; log.info( "Received message: %s\n" , message.debugStr() ) ; } ) ;

	this.uniServer.incoming.on( 'Hhelo' , message => this.receiveHello( message ) ) ;
	this.uniServer.incoming.on( 'Hbbye' , message => this.receiveBye( message ) ) ;
	this.uniServer.incoming.on( 'Khrtb' , message => this.receiveHeartbeat( message ) ) ;
	this.uniServer.incoming.on( 'Qserv' , message => this.sendServerList( message ) ) ;
} ;



/*
	A server is signaling to the master.
*/
MasterServer.prototype.receiveHello = function( message ) {
	this.addServer( message.sender , {} ) ;
} ;



/*
	A server is signaling its shutdown to the master.
*/
MasterServer.prototype.receiveBye = function( message ) {
	this.removeServer( message.sender ) ;
} ;



/*
	Send a server-list to a client.
*/
MasterServer.prototype.sendServerList = function( message ) {
	var serverList = { ipv4List: [] , ipv6List: [] } ;
	//var serverList = { ipv4List: [[192,168,0,25]] , ipv6List: [[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]] } ;

	for ( let [ , serverData ] of this.serverMap ) {

		// Filtering should occurs here

		if ( serverData.ipv4 ) {
			serverList.ipv4List.push( serverData.ipv4 ) ;
		}
		else if ( serverData.ipv6 ) {
			serverList.ipv4List.push( serverData.ipv6 ) ;
		}
	}

	//let response = this.uniServer.createMessage( 'R' , 'serv' , message.id , serverList ) ;
	//this.uniServer.sendMessage( message.sender , response ) ;
	this.uniServer.sendResponseFor( message , serverList ) ;
} ;



MasterServer.prototype.addServer = function( server , serverInfo ) {
	log.info( "addServer(): %n => %n" , server , serverInfo ) ;
	var serverData = {} ,
		id = UniProtocol.common.getAddressId( server ) ;

	if ( server.family === 'IPv4' ) {
		let ipBuffer = Buffer.allocUnsafe( 6 ) ;
		UniProtocol.ip.toBuffer( server.address , ipBuffer , 0 ) ;
		ipBuffer.writeUInt16BE( server.port , 4 ) ;
		serverData.ipv4 = ipBuffer ;
	}
	else if ( server.family === 'IPv6' ) {
		let ipBuffer = Buffer.allocUnsafe( 18 ) ;
		UniProtocol.ip.toBuffer( server.address , ipBuffer , 0 ) ;
		ipBuffer.writeUInt16BE( server.port , 16 ) ;
		serverData.ipv6 = ipBuffer ;
	}

	//serverData.hostname = typeof serverInfo.hostname === 'string' ? serverInfo.hostname : '' ;
	serverData.service = typeof serverInfo.service === 'string' ? serverInfo.service : '' ;
	serverData.mod = typeof serverInfo.mod === 'string' ? serverInfo.mod : '' ;
	serverData.protocol = + serverInfo.protocol || 0 ;
	serverData.hasPassword = !! serverInfo.hasPassword ;
	serverData.humans = + serverInfo.humans || 0 ;
	serverData.bots = + serverInfo.bots || 0 ;
	serverData.maxClients = + serverInfo.maxClients || 0 ;

	this.serverMap.set( id , serverData ) ;
	log.info( "Added server: %s => %n" , id , serverData ) ;
} ;



MasterServer.prototype.removeServer = function( server ) {
	var id = UniProtocol.common.getAddressId( server ) ;
	this.serverMap.delete( id ) ;
	log.info( "Removed server %s" , id ) ;
} ;

