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



const UniProtocol = require( '..' ) ;
const DataModel = UniProtocol.DataModel ;
const ClassMap = UniProtocol.ClassMap ;



const ipv4 = exports.ipv4 = new DataModel.FixedTypedArray( 'uint8' , 6 ) ;
const ipv6 = exports.ipv6 = new DataModel.FixedTypedArray( 'uint8' , 18 ) ;
const ipv4List = exports.ipv4List = new DataModel.TypedArray( ipv4 ) ;
const ipv6List = exports.ipv6List = new DataModel.TypedArray( ipv6 ) ;

const serverList = exports.serverList = new DataModel.SealedObject( [
	[ 'ipv4List' , ipv4List ] ,
	[ 'ipv6List' , ipv6List ]
] ) ;

