- We are creating a blockchain called "bolt" that uses proof-of-work in a similar way to bitcoin but uses an account model instead of a utxo model. We're using bun with typescript so we never have to compile the typescript we can run it directly. We can also take advantage of bun's great testing features and speed features as well.
- Bolt should have 2 main types of tests, unit tests (written in bun test suite) and bats tests (which are deployment tests). The bats tests will be responsible for spinning up entire nodes using docker and testing that they can communicate with eachother and so on.
- The docs/ directory contains documentation about technical implementation of the project. We should be adding to it and maintaining it as needed as development progresses.
- Ensure that whenever you add a feature from the plan you always write at least basic tests for it so you can make sure we never break anything as we progress.
- Ensure that we use public libp2p bootstrap nodes as a fallback (like the ones IPFS uses with a specific messaging pattern) so nodes can always find eachother.
- Remember that bun doesn't need dotenv do be included it autoamtically has it included in it's suite. Bun never needs to compile typescript either.
- Remember we should probably create the environment early on (the docker env) so that we can spawn up our entire stack before we start developing primitives.
- When referring to bolt in files like the one pasted below, do it all in lowercase.
- Don't use emojis

