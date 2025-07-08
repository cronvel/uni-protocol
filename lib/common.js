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



const crypto = require( 'crypto' ) ;

//const Logfella = require( 'logfella' ) ;
//const log = Logfella.global.use( 'Q3Client' ) ;



function TimeoutError( message ) {
	this.message = message ;
	this.code = 'timeout' ;
} ;

TimeoutError.prototype = Object.create( Error.prototype ) ;
TimeoutError.prototype.constructor = TimeoutError ;

exports.TimeoutError = TimeoutError ;



exports.getAddressId = address => {
	if ( address.family === 'IPv4' ) { return address.address + ':' + address.port ; }
	if ( address.family === 'IPv6' ) { return '[' + address.address + ']:' + address.port ; }
	return null ;
} ;



//const webcrypto = require('node:crypto').webcrypto ;
//const randomStore = new Uint32Array( 1 ) ;
//exports.getRandomUInt32 = () => crypto.getRandomValues( randomStore )[ 0 ] ;
//exports.getRandomUInt32 = () => webcrypto.getRandomValues( randomStore )[ 0 ] ;
exports.getPseudoRandomUInt32 = () => ( ( Math.random() * 65536 ) * 65536 ) + Math.random() * 65536 ;

