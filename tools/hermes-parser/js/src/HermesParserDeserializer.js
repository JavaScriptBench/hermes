/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

const HermesParserDecodeUTF8String = require('./HermesParserDecodeUTF8String');
const NODE_DESERIALIZERS = require('./HermesParserNodeDeserializers');

class HermesParserDeserializer {
  constructor(programBuffer, positionBuffer, positionBufferSize, wasmParser) {
    // Program and position buffer are memory addresses, so we must convert
    // into indices into HEAPU32 (an array of 4-byte integers).
    this.programBufferIdx = programBuffer / 4;
    this.positionBufferIdx = positionBuffer / 4;

    this.positionBufferSize = positionBufferSize;
    this.locMap = {};

    this.HEAPU8 = wasmParser.HEAPU8;
    this.HEAPU32 = wasmParser.HEAPU32;
    this.HEAPF64 = wasmParser.HEAPF64;
  }

  /**
   * Consume and return the next 4 bytes in the program buffer.
   */
  next() {
    const num = this.HEAPU32[this.programBufferIdx++];
    return num;
  }

  deserialize() {
    const program = {
      type: 'Program',
      loc: this.addEmptyLoc(),
      body: this.deserializeNodeList(),
      comments: this.deserializeComments(),
    };

    this.fillLocs();

    return program;
  }

  /**
   * Booleans are serialized as a single 4-byte integer.
   */
  deserializeBoolean() {
    return Boolean(this.next());
  }

  /**
   * Numbers are serialized directly into program buffer, taking up 8 bytes
   * preceded by 4 bytes of alignment padding if necessary.
   */
  deserializeNumber() {
    let floatIdx;

    // Numbers are aligned on 8-byte boundaries, so skip padding if we are at
    // an odd index into the 4-byte aligned program buffer.
    if (this.programBufferIdx % 2 === 0) {
      floatIdx = this.programBufferIdx / 2;
      this.programBufferIdx += 2;
    } else {
      floatIdx = (this.programBufferIdx + 1) / 2;
      this.programBufferIdx += 3;
    }

    return this.HEAPF64[floatIdx];
  }

  /**
   * Strings are serialized as a 4-byte pointer into the heap, followed
   * by their size as a 4-byte integer. The size is only present if the
   * pointer is non-null.
   */
  deserializeString() {
    const ptr = this.next();
    if (ptr === 0) {
      return null;
    }

    const size = this.next();

    return HermesParserDecodeUTF8String(ptr, size, this.HEAPU8);
  }

  /**
   * Nodes are serialized as a 4-byte integer denoting their node kind,
   * followed by a 4-byte loc ID, followed by serialized node properties.
   *
   * If the node kind is 0 the node is null, otherwise the node kind - 1 is an
   * index into the array of node deserialization functions.
   */
  deserializeNode() {
    const nodeType = this.next();
    if (nodeType === 0) {
      return null;
    }

    const nodeDeserializer = NODE_DESERIALIZERS[nodeType - 1].bind(this);
    return nodeDeserializer();
  }

  /**
   * Node lists are serialized as a 4-byte integer denoting the number of
   * elements in the list, followed by the serialized elements.
   */
  deserializeNodeList() {
    const size = this.next();
    const nodeList = [];

    for (let i = 0; i < size; i++) {
      nodeList.push(this.deserializeNode());
    }

    return nodeList;
  }

  // Matches StoredComment::Kind enum in JSLexer.h
  commentTypes = ['CommentLine', 'CommentBlock', 'InterpreterDirective'];

  /**
   * Comments are serialized as a node list, where each comment is serialized
   * as a 4-byte integer denoting comment type, followed by a 4-byte value
   * denoting the loc ID, followed by a serialized string for the comment value.
   */
  deserializeComments() {
    const size = this.next();
    const comments = [];

    for (let i = 0; i < size; i++) {
      const commentType = this.commentTypes[this.next()];
      const loc = this.addEmptyLoc();
      const value = this.deserializeString();
      comments.push({
        type: commentType,
        loc,
        value,
      });
    }

    return comments;
  }

  /**
   * While deserializing the AST locations are represented by
   * a 4-byte loc ID. This is used to create a map of loc IDs to empty loc
   * objects that are filled after the AST has been deserialized.
   */
  addEmptyLoc() {
    const loc = {};
    this.locMap[this.next()] = loc;
    return loc;
  }

  /**
   * Positions are serialized as a loc ID which denotes which loc it is associated with,
   * followed by kind which denotes whether it is a start or end position,
   * followed by line, column, and offset (4-bytes each).
   */
  fillLocs() {
    for (let i = 0; i < this.positionBufferSize; i++) {
      const locId = this.HEAPU32[this.positionBufferIdx++];
      const kind = this.HEAPU32[this.positionBufferIdx++];
      const line = this.HEAPU32[this.positionBufferIdx++];
      const column = this.HEAPU32[this.positionBufferIdx++];
      const offset = this.HEAPU32[this.positionBufferIdx++];

      const loc = this.locMap[locId];
      if (kind === 0) {
        loc.start = {
          line,
          column,
        };
        loc.rangeStart = offset;
      } else {
        loc.end = {
          line,
          column,
        };
        loc.rangeEnd = offset;
      }
    }
  }
}

module.exports = HermesParserDeserializer;