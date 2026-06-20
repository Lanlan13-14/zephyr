"""
RDP Security Policy Module
Provides connection security enforcement with immutable policy configuration
"""

import os
import re
import json
import copy
import logging
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass

# Default path for security policy configuration
DEFAULT_SECURITY_POLICY_PATH = "/app/security/rdp-bridge-policy.json"

# Environment variable for overriding the default path
SECURITY_POLICY_PATH_ENV = "RDP_BRIDGE_SECURITY_POLICY_PATH"

logger = logging.getLogger(__name__)


def deep_freeze(obj: Any) -> Any:
    """
    Deep freeze an object to prevent tampering.
    In Python, we use immutable types (tuple, frozenset) and readonly patterns.
    
    Args:
        obj: Object to freeze
        
    Returns:
        Frozen (immutable) version of the object
    """
    if obj is None or isinstance(obj, (int, float, str, bool)):
        return obj
    
    if isinstance(obj, list):
        return tuple(deep_freeze(el) for el in obj)
    
    if isinstance(obj, dict):
        return MappingProxyType({k: deep_freeze(v) for k, v in obj.items()})
    
    return obj


# Import MappingProxyType for read-only dict
from types import MappingProxyType


def glob_to_regex(glob: str) -> re.Pattern:
    """
    Convert a glob pattern to a RegExp.
    Supports: * (any chars), ? (single char), [abc] (char class), [!abc] (negated char class)
    
    Args:
        glob: Glob pattern
        
    Returns:
        Compiled regex pattern
    """
    regex = ''
    i = 0
    length = len(glob)
    
    while i < length:
        char = glob[i]
        
        if char == '*':
            # * matches any sequence of characters
            regex += '.*'
        elif char == '?':
            # ? matches exactly one character
            regex += '.'
        elif char == '[':
            # Character class - find closing bracket
            j = i + 1
            class_content = ''
            negated = False
            
            # Check for negation
            if j < length and glob[j] in ('!', '^'):
                negated = True
                j += 1
            
            # Collect characters until ]
            while j < length and glob[j] != ']':
                # Escape next character if backslash
                if glob[j] == '\\' and j + 1 < length:
                    class_content += '\\' + glob[j + 1]
                    j += 2
                else:
                    class_content += glob[j]
                    j += 1
            
            if j < length and glob[j] == ']':
                regex += '[' + ('^' if negated else '') + class_content + ']'
                i = j
            else:
                # No closing bracket - treat [ as literal
                regex += '\\['
        elif char == '\\':
            # Escape next character
            if i + 1 < length:
                regex += '\\' + glob[i + 1]
                i += 1
            else:
                regex += '\\\\'
        elif char in '.+^${}()|':
            # Escape regex special characters
            regex += '\\' + char
        else:
            regex += char
        
        i += 1
    
    return re.compile('^' + regex + '$', re.IGNORECASE)


def match_glob(s: str, pattern: str) -> bool:
    """
    Check if a string matches a glob pattern.
    
    Args:
        s: String to test
        pattern: Glob pattern
        
    Returns:
        True if matches
    """
    try:
        regex = glob_to_regex(pattern)
        return bool(regex.match(s))
    except Exception as e:
        logger.error(f"[RDPSecurityPolicy] Invalid glob pattern: {pattern} - {e}")
        return False


def is_ipv4(s: str) -> bool:
    """
    Check if a string is a valid IPv4 address.
    
    Args:
        s: String to check
        
    Returns:
        True if valid IPv4
    """
    ipv4_regex = re.compile(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$')
    match = ipv4_regex.match(s)
    if not match:
        return False
    
    # Validate each octet is 0-255
    for i in range(1, 5):
        octet = int(match.group(i))
        if octet < 0 or octet > 255:
            return False
    return True


def ipv4_to_int(ip: str) -> int:
    """
    Convert IPv4 address string to 32-bit integer.
    
    Args:
        ip: IPv4 address
        
    Returns:
        32-bit integer representation
    """
    parts = [int(p) for p in ip.split('.')]
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) & 0xFFFFFFFF


def is_ip_in_cidr(ip: str, cidr: str) -> bool:
    """
    Check if an IPv4 address is within a CIDR range.
    
    Args:
        ip: IPv4 address to check
        cidr: CIDR notation (e.g., "192.168.1.0/24")
        
    Returns:
        True if IP is within CIDR range
    """
    parts = cidr.split('/')
    range_ip = parts[0]
    prefix = int(parts[1]) if len(parts) > 1 else 32
    
    if not is_ipv4(range_ip) or prefix < 0 or prefix > 32:
        return False
    
    ip_int = ipv4_to_int(ip)
    range_int = ipv4_to_int(range_ip)
    
    # Create mask from prefix length
    if prefix == 0:
        mask = 0
    else:
        mask = (~0 << (32 - prefix)) & 0xFFFFFFFF
    
    return (ip_int & mask) == (range_int & mask)


@dataclass
class ValidationResult:
    """Result of a security policy validation."""
    allowed: bool
    reason: Optional[str] = None


class RDPSecurityPolicy:
    """
    RDP Security Policy Enforcer.
    Immutable security policy that validates connection destinations.
    """
    
    def __init__(self, policy: Optional[Dict[str, Any]] = None, freeze: bool = True):
        """
        Create a new security policy.
        
        Args:
            policy: Security policy configuration
            freeze: Whether to deep freeze the policy
        """
        if policy is None:
            policy = {}
        
        # Validate and normalize policy
        normalized_policy = {}
        
        if isinstance(policy.get('allowedHostnames'), list):
            normalized_policy['allowedHostnames'] = list(policy['allowedHostnames'])
        
        if isinstance(policy.get('allowedIpv4Cidrs'), list):
            normalized_policy['allowedIpv4Cidrs'] = list(policy['allowedIpv4Cidrs'])
        
        if isinstance(policy.get('allowedDestinationRegex'), list):
            normalized_policy['allowedDestinationRegex'] = list(policy['allowedDestinationRegex'])
        
        # Pre-compile regex patterns for performance
        self._compiled_regexes: List[re.Pattern] = []
        if 'allowedDestinationRegex' in normalized_policy:
            for pattern in normalized_policy['allowedDestinationRegex']:
                try:
                    self._compiled_regexes.append(re.compile(pattern))
                except Exception as e:
                    logger.error(f"[RDPSecurityPolicy] Invalid regex pattern: {pattern} - {e}")
        
        # Deep freeze if requested (default: True)
        if freeze:
            self._policy = deep_freeze(normalized_policy)
            self._compiled_regexes = tuple(self._compiled_regexes)
        else:
            self._policy = normalized_policy
    
    def has_rules(self) -> bool:
        """
        Check if policy has any rules defined.
        
        Returns:
            True if at least one rule is defined
        """
        policy = self._policy if isinstance(self._policy, dict) else dict(self._policy)
        
        allowed_hostnames = policy.get('allowedHostnames', ())
        allowed_cidrs = policy.get('allowedIpv4Cidrs', ())
        allowed_regex = policy.get('allowedDestinationRegex', ())
        
        return bool(
            (allowed_hostnames and len(allowed_hostnames) > 0) or
            (allowed_cidrs and len(allowed_cidrs) > 0) or
            (allowed_regex and len(allowed_regex) > 0)
        )
    
    def validate(self, host: str, port: int = 3389) -> ValidationResult:
        """
        Validate a connection destination against the security policy.
        
        Args:
            host: Hostname or IP address
            port: Port number (default: 3389)
            
        Returns:
            ValidationResult with allowed status and optional reason
        """
        # If no rules defined, allow all connections
        if not self.has_rules():
            return ValidationResult(allowed=True)
        
        destination = f"{host}:{port}"
        host_is_ipv4 = is_ipv4(host)
        
        policy = self._policy if isinstance(self._policy, dict) else dict(self._policy)
        
        # Check destination regex patterns first (applies to both hostnames and IPs)
        allowed_regex = policy.get('allowedDestinationRegex', ())
        if allowed_regex and len(allowed_regex) > 0:
            for regex in self._compiled_regexes:
                if regex.search(destination):
                    return ValidationResult(allowed=True)
        
        # Check hostname rules (only for non-IP hosts)
        allowed_hostnames = policy.get('allowedHostnames', ())
        if not host_is_ipv4 and allowed_hostnames and len(allowed_hostnames) > 0:
            for pattern in allowed_hostnames:
                if match_glob(host, pattern):
                    return ValidationResult(allowed=True)
        
        # Check IPv4 CIDR rules (only for IP addresses)
        allowed_cidrs = policy.get('allowedIpv4Cidrs', ())
        if host_is_ipv4 and allowed_cidrs and len(allowed_cidrs) > 0:
            for cidr in allowed_cidrs:
                if is_ip_in_cidr(host, cidr):
                    return ValidationResult(allowed=True)
        
        # No rules matched
        return ValidationResult(
            allowed=False,
            reason=f"Connection to {destination} blocked by security policy"
        )
    
    def get_policy(self) -> Dict[str, Any]:
        """
        Get a readonly copy of the policy (for debugging).
        
        Returns:
            Policy copy
        """
        # Return the frozen policy directly (it's already immutable)
        if isinstance(self._policy, MappingProxyType):
            return dict(self._policy)
        return copy.deepcopy(self._policy)


def create_security_policy(policy: Optional[Dict[str, Any]] = None, freeze: bool = True) -> RDPSecurityPolicy:
    """
    Create a security policy with optional deep freeze.
    
    Args:
        policy: Policy configuration
        freeze: Whether to deep freeze
        
    Returns:
        Security policy instance
    """
    return RDPSecurityPolicy(policy, freeze)


def load_security_policy_from_file(path: Optional[str] = None) -> RDPSecurityPolicy:
    """
    Load security policy from a JSON file.
    
    Args:
        path: Path to the policy JSON file. If None, uses environment variable
              RDP_BRIDGE_SECURITY_POLICY_PATH or defaults to /app/security/rdp-bridge-policy.json
              
    Returns:
        Security policy instance
    """
    if path is None:
        path = os.environ.get(SECURITY_POLICY_PATH_ENV, DEFAULT_SECURITY_POLICY_PATH)
    
    try:
        with open(path, 'r', encoding='utf-8') as f:
            policy_data = json.load(f)
        logger.info(f"[RDPSecurityPolicy] Loaded security policy from {path}")
        return create_security_policy(policy_data)
    except FileNotFoundError:
        logger.warning(f"[RDPSecurityPolicy] Security policy file not found: {path}, using empty policy (allow all)")
        return create_security_policy({})
    except json.JSONDecodeError as e:
        logger.error(f"[RDPSecurityPolicy] Invalid JSON in security policy file {path}: {e}")
        return create_security_policy({})
    except Exception as e:
        logger.error(f"[RDPSecurityPolicy] Error loading security policy from {path}: {e}")
        return create_security_policy({})


def get_security_policy_path() -> str:
    """
    Get the configured security policy path.
    
    Returns:
        The path from environment variable or default
    """
    return os.environ.get(SECURITY_POLICY_PATH_ENV, DEFAULT_SECURITY_POLICY_PATH)


def load_security_policy_from_env() -> RDPSecurityPolicy:
    """
    Load security policy from environment variables.
    
    Environment variables:
        SECURITY_ALLOWED_HOSTNAMES: Comma-separated list of hostname glob patterns
        SECURITY_ALLOWED_IPV4_CIDRS: Comma-separated list of IPv4 CIDR ranges
        SECURITY_ALLOWED_DEST_REGEX: A destination regex pattern
        SECURITY_ALLOWED_DEST_REGEX_N: Additional regex patterns where N is a number (e.g., _1, _2, etc.)
    
    Each entry in comma-separated lists will be trimmed of whitespace.
    
    Returns:
        Security policy instance
    """
    policy_data: Dict[str, Any] = {}
    
    # Load allowed hostnames (comma-separated, trimmed)
    hostnames_env = os.environ.get('SECURITY_ALLOWED_HOSTNAMES', '').strip()
    if hostnames_env:
        hostnames = [h.strip() for h in hostnames_env.split(',') if h.strip()]
        if hostnames:
            policy_data['allowedHostnames'] = hostnames
    
    # Load allowed IPv4 CIDRs (comma-separated, trimmed)
    cidrs_env = os.environ.get('SECURITY_ALLOWED_IPV4_CIDRS', '').strip()
    if cidrs_env:
        cidrs = [c.strip() for c in cidrs_env.split(',') if c.strip()]
        if cidrs:
            policy_data['allowedIpv4Cidrs'] = cidrs
    
    # Load allowed destination regex patterns
    # First check SECURITY_ALLOWED_DEST_REGEX, then SECURITY_ALLOWED_DEST_REGEX_N
    regex_patterns: List[str] = []
    
    # Check base regex variable
    base_regex = os.environ.get('SECURITY_ALLOWED_DEST_REGEX', '').strip()
    if base_regex:
        regex_patterns.append(base_regex)
    
    # Check numbered regex variables (SECURITY_ALLOWED_DEST_REGEX_1, _2, etc.)
    regex_pattern = re.compile(r'^SECURITY_ALLOWED_DEST_REGEX_(\d+)$')
    numbered_vars: List[Tuple[int, str]] = []
    
    for env_key, env_value in os.environ.items():
        match = regex_pattern.match(env_key)
        if match:
            num = int(match.group(1))
            value = env_value.strip()
            if value:
                numbered_vars.append((num, value))
    
    # Sort by number and add to patterns
    numbered_vars.sort(key=lambda x: x[0])
    for _, pattern in numbered_vars:
        regex_patterns.append(pattern)
    
    if regex_patterns:
        policy_data['allowedDestinationRegex'] = regex_patterns
        
    return create_security_policy(policy_data)


# Singleton instance for global use
_global_security_policy: Optional[RDPSecurityPolicy] = None


def get_security_policy() -> RDPSecurityPolicy:
    """
    Get the global security policy instance.
    
    First loads from file. If the file-based policy has no rules,
    falls back to loading from environment variables.
    
    Returns:
        The global security policy instance
    """
    global _global_security_policy
    if _global_security_policy is None:
        _global_security_policy = load_security_policy_from_file()
        # If file-based policy is empty, try environment variables as fallback
        if not _global_security_policy.has_rules():
            env_policy = load_security_policy_from_env()
            if env_policy.has_rules():
                logger.info("[RDPSecurityPolicy] Using environment-based policy as fallback")
                _global_security_policy = env_policy
    return _global_security_policy


def reload_security_policy() -> RDPSecurityPolicy:
    """
    Reload the global security policy.
    
    First loads from file. If the file-based policy has no rules,
    falls back to loading from environment variables.
    
    Returns:
        The newly loaded security policy instance
    """
    global _global_security_policy
    _global_security_policy = load_security_policy_from_file()
    # If file-based policy is empty, try environment variables as fallback
    if not _global_security_policy.has_rules():
        env_policy = load_security_policy_from_env()
        if env_policy.has_rules():
            logger.info("[RDPSecurityPolicy] Using environment-based policy as fallback")
            _global_security_policy = env_policy
    return _global_security_policy
