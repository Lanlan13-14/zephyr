/**
 * RDP Security Policy Module
 * Provides connection security enforcement with immutable policy configuration
 */

/**
 * Deep freeze an object to prevent tampering
 * @param {any} obj - Object to freeze
 * @returns {any} Frozen object
 */
export function deepFreeze(obj) {
    // Handle primitives and null
    if (obj === null || typeof obj !== 'object') return obj;

    // Freeze arrays first: elements may need freezing too
    if (Array.isArray(obj)) {
        for (const el of obj) deepFreeze(el);
        return Object.freeze(obj);
    }

    // Freeze plain objects
    for (const key of Object.keys(obj)) {
        deepFreeze(obj[key]); // recurse
    }
    return Object.freeze(obj);
}

/**
 * @typedef {Object} SecurityPolicy
 * @property {string[]} [allowedHostnames] - Allowed hostnames (non-IP addresses)
 * @property {string[]} [allowedIpv4Cidrs] - Allowed IPv4 CIDR ranges (e.g., "192.168.1.0/24")
 * @property {string[]} [allowedDestinationRegex] - Regex patterns for host:port strings
 */

/**
 * Convert a glob pattern to a RegExp
 * Supports: * (any chars), ? (single char), [abc] (char class), [!abc] (negated char class)
 * @param {string} glob - Glob pattern
 * @returns {RegExp} Compiled regex
 */
function globToRegex(glob) {
    let regex = '';
    let i = 0;
    
    while (i < glob.length) {
        const char = glob[i];
        
        switch (char) {
            case '*':
                // * matches any sequence of characters
                regex += '.*';
                break;
            case '?':
                // ? matches exactly one character
                regex += '.';
                break;
            case '[':
                // Character class - find closing bracket
                let j = i + 1;
                let classContent = '';
                let negated = false;
                
                // Check for negation
                if (glob[j] === '!' || glob[j] === '^') {
                    negated = true;
                    j++;
                }
                
                // Collect characters until ]
                while (j < glob.length && glob[j] !== ']') {
                    // Escape special regex chars inside class (except - and ])
                    if (glob[j] === '\\' && j + 1 < glob.length) {
                        classContent += '\\' + glob[j + 1];
                        j += 2;
                    } else {
                        classContent += glob[j];
                        j++;
                    }
                }
                
                if (j < glob.length && glob[j] === ']') {
                    regex += '[' + (negated ? '^' : '') + classContent + ']';
                    i = j;
                } else {
                    // No closing bracket - treat [ as literal
                    regex += '\\[';
                }
                break;
            case '\\':
                // Escape next character
                if (i + 1 < glob.length) {
                    regex += '\\' + glob[i + 1];
                    i++;
                } else {
                    regex += '\\\\';
                }
                break;
            // Escape regex special characters
            case '.':
            case '+':
            case '^':
            case '$':
            case '{':
            case '}':
            case '(':
            case ')':
            case '|':
                regex += '\\' + char;
                break;
            default:
                regex += char;
        }
        i++;
    }
    
    return new RegExp('^' + regex + '$', 'i');
}

/**
 * Check if a string matches a glob pattern
 * @param {string} str - String to test
 * @param {string} pattern - Glob pattern
 * @returns {boolean} True if matches
 */
function matchGlob(str, pattern) {
    try {
        const regex = globToRegex(pattern);
        return regex.test(str);
    } catch (e) {
        console.error('[RDPSecurityPolicy] Invalid glob pattern:', pattern, e);
        return false;
    }
}

/**
 * Check if a string is a valid IPv4 address
 * @param {string} str - String to check
 * @returns {boolean} True if valid IPv4
 */
function isIPv4(str) {
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = str.match(ipv4Regex);
    if (!match) return false;
    
    // Validate each octet is 0-255
    for (let i = 1; i <= 4; i++) {
        const octet = parseInt(match[i], 10);
        if (octet < 0 || octet > 255) return false;
    }
    return true;
}

/**
 * Convert IPv4 address string to 32-bit integer
 * @param {string} ip - IPv4 address
 * @returns {number} 32-bit integer representation
 */
function ipv4ToInt(ip) {
    const parts = ip.split('.').map(p => parseInt(p, 10));
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Check if an IPv4 address is within a CIDR range
 * @param {string} ip - IPv4 address to check
 * @param {string} cidr - CIDR notation (e.g., "192.168.1.0/24")
 * @returns {boolean} True if IP is within CIDR range
 */
function isIpInCidr(ip, cidr) {
    const [range, prefixStr] = cidr.split('/');
    const prefix = prefixStr !== undefined ? parseInt(prefixStr, 10) : 32;
    
    if (!isIPv4(range) || isNaN(prefix) || prefix < 0 || prefix > 32) {
        return false;
    }
    
    const ipInt = ipv4ToInt(ip);
    const rangeInt = ipv4ToInt(range);
    
    // Create mask from prefix length
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    
    return (ipInt & mask) === (rangeInt & mask);
}

/**
 * RDP Security Policy Enforcer
 * Immutable security policy that validates connection destinations
 */
export class RDPSecurityPolicy {
    /** @type {SecurityPolicy} */
    #policy;
    
    /** @type {RegExp[]} */
    #compiledRegexes;
    
    /**
     * Create a new security policy
     * @param {SecurityPolicy} policy - Security policy configuration
     * @param {boolean} [freeze=true] - Whether to deep freeze the policy
     */
    constructor(policy = {}, freeze = true) {
        // Validate and normalize policy
        const normalizedPolicy = {
            allowedHostnames: Array.isArray(policy.allowedHostnames) 
                ? [...policy.allowedHostnames] 
                : undefined,
            allowedIpv4Cidrs: Array.isArray(policy.allowedIpv4Cidrs) 
                ? [...policy.allowedIpv4Cidrs] 
                : undefined,
            allowedDestinationRegex: Array.isArray(policy.allowedDestinationRegex) 
                ? [...policy.allowedDestinationRegex] 
                : undefined,
        };
        
        // Remove undefined properties
        Object.keys(normalizedPolicy).forEach(key => {
            if (normalizedPolicy[key] === undefined) {
                delete normalizedPolicy[key];
            }
        });
        
        // Pre-compile regex patterns for performance
        this.#compiledRegexes = [];
        if (normalizedPolicy.allowedDestinationRegex) {
            for (const pattern of normalizedPolicy.allowedDestinationRegex) {
                try {
                    this.#compiledRegexes.push(new RegExp(pattern));
                } catch (e) {
                    console.error('[RDPSecurityPolicy] Invalid regex pattern:', pattern, e);
                }
            }
        }
        
        // Deep freeze if requested (default: true)
        this.#policy = freeze ? deepFreeze(normalizedPolicy) : normalizedPolicy;
        
        // Freeze the compiled regexes array too
        if (freeze) {
            Object.freeze(this.#compiledRegexes);
        }
    }
    
    /**
     * Check if policy has any rules defined
     * @returns {boolean} True if at least one rule is defined
     */
    hasRules() {
        return !!(
            this.#policy.allowedHostnames?.length ||
            this.#policy.allowedIpv4Cidrs?.length ||
            this.#policy.allowedDestinationRegex?.length
        );
    }
    
    /**
     * Validate a connection destination against the security policy
     * @param {string} host - Hostname or IP address
     * @param {number} [port=3389] - Port number
     * @returns {{allowed: boolean, reason?: string}} Validation result
     */
    validate(host, port = 3389) {
        // If no rules defined, allow all connections
        if (!this.hasRules()) {
            return { allowed: true };
        }
        
        const destination = `${host}:${port}`;
        const hostIsIPv4 = isIPv4(host);
        
        // Check destination regex patterns first (applies to both hostnames and IPs)
        if (this.#policy.allowedDestinationRegex?.length) {
            for (const regex of this.#compiledRegexes) {
                if (regex.test(destination)) {
                    return { allowed: true };
                }
            }
        }
        
        // Check hostname rules (only for non-IP hosts)
        if (!hostIsIPv4 && this.#policy.allowedHostnames?.length) {
            for (const pattern of this.#policy.allowedHostnames) {
                if (matchGlob(host, pattern)) {
                    return { allowed: true };
                }
            }
        }
        
        // Check IPv4 CIDR rules (only for IP addresses)
        if (hostIsIPv4 && this.#policy.allowedIpv4Cidrs?.length) {
            for (const cidr of this.#policy.allowedIpv4Cidrs) {
                if (isIpInCidr(host, cidr)) {
                    return { allowed: true };
                }
            }
        }
        
        // No rules matched
        return {
            allowed: false,
            reason: `Connection to ${destination} blocked by security policy`
        };
    }
    
    /**
     * Get a readonly copy of the policy (for debugging)
     * @returns {SecurityPolicy} Policy copy
     */
    getPolicy() {
        // Return the frozen policy directly (it's already immutable)
        return this.#policy;
    }
}

/**
 * Create a security policy with optional deep freeze
 * @param {SecurityPolicy} policy - Policy configuration
 * @param {boolean} [freeze=true] - Whether to deep freeze
 * @returns {RDPSecurityPolicy} Security policy instance
 */
export function createSecurityPolicy(policy, freeze = true) {
    return new RDPSecurityPolicy(policy, freeze);
}
