#!/usr/bin/env node
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

//const os = require( 'os' ) ;
//const path = require( 'path' ) ;
//const fs = require( 'fs' ) ;

const UniProtocol = require( '..' ) ;

const masterData = require( './master-data.js' ) ;

const string = require( 'string-kit' ) ;
const Promise = require( 'seventh' ) ;

const termkit = require( 'terminal-kit' ) ;
const term = termkit.terminal ;

const cliManager = require( 'utterminal' ).cli ;
const packageJson = require( '../package.json' ) ;



async function cli() {
	/* eslint-disable indent */
	cliManager.package( packageJson )
		.usage( "<port> [--option1] [...]" )
		//.app( "Get All Servers" )
		//.noIntro
		.helpOption.logOptions
		.camel
		.description( "Test UniProtocol server." )
		.arg( 'server' , '127.0.0.1' ).string.mandatory
			.description( "The server to connect to." )
		.arg( 'port' , 1234 ).number.mandatory
			.description( "The port to listen." ) ;
	/* eslint-enable indent */

	var args = cliManager.run() ;
	//console.log( "Args:" , args ) ;

	var masterClient = new UniMasterClient( [ { address: args.server , port: args.port } ] ) ;
	masterClient.query() ;
} ;



function UniMasterClient( masterServerList , params = {} ) {
	this.uniClient = new UniProtocol( {
		protocolSignature: 'UNM' ,
		maxPacketSize: UniProtocol.IPv4_MTU ,
		binaryDataParams: {
			perCommand: {
				Rserv: {
					model: masterData.serverList
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



UniMasterClient.prototype.query = async function() {
	this.uniClient.startClient() ;
	
	// Debug
	this.uniClient.on( 'message' , message => { message.decodeData() ; term( "Received message: %s\n" , message.debugStr() ) ; } ) ;

	var masterResponseCount = 0 ,
		serverList = [] ,
		serverSet = new Set() ;

	var responseList = await Promise.map( this.masterServerList , dest => {
		var responsePromise = Promise.fromThenable( this.uniClient.sendQuery( dest , 'serv' ) ) ;
		setTimeout( () => responsePromise.resolve( null ) , this.masterTimeout ) ;
		return responsePromise.then( response => { masterResponseCount ++ ; return response ; } ).catch( () => null ) ;
	} ) ;
	
	console.log( masterResponseCount + " response(s) received!" ) ;

	for ( let response of responseList ) {
		if ( ! response ) { continue ; }
		let responseServerList = UniMasterClient.toServerList( response.decodeData() ) ;

		for ( let server of responseServerList ) {
			let serverId ;

			if ( server.ipv4 ) { serverId = server.ipv4 + ':' + server.port ; }
			else if ( server.ipv6 ) { serverId = '[' + server.ipv6 + ']:' + server.port ; }
			else { continue ; }

			if ( serverSet.has( serverId ) ) { continue ; }
			serverSet.add( server ) ;
			serverList.push( server ) ;
		}
	}

	this.displayServers( serverList ) ;
} ;



UniMasterClient.toServerList = function( data ) {
	var serverList = [] ;

	for ( let serverArray of data.ipv4List ) {
		let serverBuffer = Buffer.from( serverArray ) ;
		let ipv4 = UniProtocol.ip.toString( serverBuffer , 0 , 4 ) ;
		let port = serverBuffer.readUInt16BE( 4 ) ;
		serverList.push( { ipv4 , port } ) ;
	}

	for ( let serverArray of data.ipv6List ) {
		let serverBuffer = Buffer.from( serverArray ) ;
		let ipv6 = UniProtocol.ip.toString( serverBuffer , 0 , 16 ) ;
		let port = serverBuffer.readUInt16BE( 16 ) ;
		serverList.push( { ipv6 , port } ) ;
	}

	return serverList ;
}



UniMasterClient.prototype.displayServers = function( serverList ) {
	console.log( serverList ) ;
}



cli() ;

