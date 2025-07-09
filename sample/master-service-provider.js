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

	var masterServiceProvider = new UniMasterServiceProvider( [ { address: args.server , port: args.port } ] ) ;
	masterServiceProvider.start() ;
} ;



function UniMasterServiceProvider( masterServerList , params = {} ) {
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
	this.serverInfo = params.serverInfo || {} ;
	this.notifyTimer = null ;
}



UniMasterServiceProvider.prototype.start = function() {
	term( "My IP: %s\n" , UniProtocol.ip.address() ) ;
	//term( "Interfaces: %Y\n" , os.networkInterfaces() ) ;

	//console.log( "UniServer:" , server ) ;

	this.uniServer.startServer() ;

	// Debug:
	this.uniServer.on( 'message' , message => { message.decodeData() ; term( "Received message: %s\n" , message.debugStr() ) ; } ) ;

	this.uniServer.incoming.on( 'Qinfo' , message => this.sendServerInfo( message ) ) ;

	this.notifyTimer = setInterval( () => this.notifyMasterServers() , 5000 ) ;
} ;



/*
	Set the whole server info.
*/
UniMasterServiceProvider.prototype.setServerInfo = function( serverInfo ) {
	if ( ! serverInfo || typeof serverInfo !== 'object' ) { return ; }
	this.serverInfo = serverInfo ;
} ;



/*
	Update server info: update only provided keys.
*/
UniMasterServiceProvider.prototype.updateServerInfo = function( serverInfo ) {
	if ( ! serverInfo || typeof serverInfo !== 'object' ) { return ; }
	Object.assign( this.serverInfo , serverInfo ) ;
} ;



/*
	Send a server info to a client.
*/
UniMasterServiceProvider.prototype.sendServerInfo = function( message ) {
	this.uniServer.sendResponseFor( message , this.serverInfo ) ;
} ;



/*
	Notify master servers.
*/
UniMasterServiceProvider.prototype.notifyMasterServers = function( message ) {
	for ( let server of this.masterServerList ) {
		console.log( "Send hello to" , server ) ;
		this.uniServer.sendHello( server , 'helo' ) ;
	}
} ;



cli() ;

