/**
 * Node only: every hash through node:crypto's SHA-256 (native) instead of the core's
 * pure-TypeScript one. Same algorithm, same bytes, same ids; verifying a large run was
 * spending most of its time hashing.
 */
import { createHash } from 'node:crypto';
import { useSha256 } from '../core/hash.js';

useSha256((input) => createHash('sha256').update(input, 'utf8').digest('hex'));
