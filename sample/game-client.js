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

const gameData = require( './game-data.js' ) ;

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

	run( args ) ;
} ;



async function run( config ) {
	var client = new UniProtocol( {
		maxPacketSize: UniProtocol.IPv4_MTU ,
		binaryDataParams: {
			perCommand: {
				Rstat: {
					model: gameData.gameState
				}
			}
		}
	} ) ;
	//console.log( "UniClient:" , client ) ;

	client.startClient() ;
	
	client.on( 'message' , message => {
		message.decodeData() ;
		term( "Received message: %s\n" , message.debugStr() ) ;
	} ) ;
	
	var dest = { address: config.server , port: config.port } ;
	
	var data = "Start: " + ( "a big string, ".repeat( 200 ) ) + "end..." ;
	var message = client.createMessage( 'Q' , 'stat' ) ;
	client.sendMessage( dest , message ) ;
}



cli() ;

