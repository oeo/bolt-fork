# hashing

bolt consensus uses sha-256. chain configuration cannot select another proof-of-work hash.

## block work

each block target is derived from its integer difficulty:

```text
maxTarget = 2^256 - 1
target = floor(maxTarget / difficulty)
work = floor(2^256 / (target + 1))
```

chain selection compares the sum of block work. summing difficulty values is not equivalent for every target and is not used.

## other hashes

the hash utility also exposes sha-512, double-sha-256, and the current scrypt-compatible helper for non-consensus callers. these algorithms cannot validate or mine bolt blocks through `Blockchain`.
