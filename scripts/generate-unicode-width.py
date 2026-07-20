#!/usr/bin/env python3
import hashlib,re,sys
src=open(sys.argv[1],encoding='utf-8').read();ranges=[]
for raw in src.splitlines():
 line=raw.split('#',1)[0].strip()
 if not line:continue
 m=re.match(r'([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*([A-Za-z]+)',line)
 if not m or m.group(3) not in ('W','F'):continue
 a=int(m.group(1),16);b=int(m.group(2) or m.group(1),16)
 if ranges and a==ranges[-1][1]+1:ranges[-1]=(ranges[-1][0],b)
 else:ranges.append((a,b))
out=['// Generated from Unicode 15.1 EastAsianWidth.txt','// sha256: '+hashlib.sha256(src.encode()).hexdigest(),'pub const WideRange = struct { first: u21, last: u21 };','pub const wide_ranges = [_]WideRange{']
for a,b in ranges:out.append(f'    .{{ .first = 0x{a:X}, .last = 0x{b:X} }},')
out+=['};',''];open(sys.argv[2],'w').write('\n'.join(out));print(f'{len(ranges)} merged W/F ranges')
