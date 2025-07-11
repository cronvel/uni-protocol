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



function Client( masterServerList , params = {} ) {
	this.uniClient = new UniProtocol( {
		protocolSignature: 'UNM' ,
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

	this.masterTimeout = + params.masterTimeout || 2000 ;
	this.masterServerList = Array.isArray( masterServerList ) ? masterServerList : [] ;
}

module.exports = Client ;



/*
	Query Master Servers, then query Service Providers.
*/
Client.prototype.queryAllServers = async function() {
	this.uniClient.startClient() ;

	// Debug
	this.uniClient.on( 'message' , message => { message.decodeData() ; log.info( "Received message: %s\n" , message.debugStr() ) ; } ) ;

	var masterResponseCount = 0 ,
		serverMap = new Map() ;

	var responseList = await Promise.map( this.masterServerList , dest => {
		var responsePromise = Promise.fromThenable( this.uniClient.sendQuery( dest , 'serv' ) ) ;
		setTimeout( () => responsePromise.resolve( null ) , this.masterTimeout ) ;
		return responsePromise.then( response => { masterResponseCount ++ ; return response ; } ).catch( () => null ) ;
	} ) ;

	console.log( masterResponseCount + " response(s) received!" ) ;

	for ( let response of responseList ) {
		if ( ! response ) { continue ; }
		let responseServerList = Client.toServerList( response.decodeData() ) ;

		for ( let server of responseServerList ) {
			let serverId ;

			if ( server.ipv4 ) { serverId = server.ipv4 + ':' + server.port ; }
			else if ( server.ipv6 ) { serverId = '[' + server.ipv6 + ']:' + server.port ; }
			else { continue ; }

			if ( serverMap.has( serverId ) ) { continue ; }
			serverMap.set( serverId , { address: server , info: null } ) ;
		}
	}

	await Promise.map( serverMap.keys() , serverId => {
		let server = serverMap.get( serverId ) ;
		return this.uniClient.sendQuery( server.address , 'info' , undefined , { retries: 3 } )
			.then( message => server.info = message.decodeData() )
			.catch( error => server.error = error ) ;
	} ) ;

	this.displayServers( serverMap ) ;
} ;



Client.toServerList = function( data ) {
	var serverList = [] ;

	for ( let serverArray of data.ipv4List ) {
		let serverBuffer = Buffer.from( serverArray ) ;
		let ipv4 = UniProtocol.ip.toString( serverBuffer , 0 , 4 ) ;
		let port = serverBuffer.readUInt16BE( 4 ) ;
		serverList.push( { ipv4 , address: ipv4 , port } ) ;
	}

	for ( let serverArray of data.ipv6List ) {
		let serverBuffer = Buffer.from( serverArray ) ;
		let ipv6 = UniProtocol.ip.toString( serverBuffer , 0 , 16 ) ;
		let port = serverBuffer.readUInt16BE( 16 ) ;
		serverList.push( { ipv6 , address: ipv6 , port } ) ;
	}

	return serverList ;
} ;



Client.prototype.displayServers = function( serverMap ) {
	for ( let [ serverId , serverData ] of serverMap ) {
		console.log( serverId , serverData ) ;
	}
} ;

