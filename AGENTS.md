greetings, monk-agent.

- we are creating a blockchain called "bolt" that uses proof-of-work in a similar way to bitcoin but uses an account model instead of a utxo model, similar to ethereum. we're using bun with typescript so we never have to compile the typescript we can run it directly. we can also take advantage of bun's great testing features and speed features as well.
- bolt should have 2 main types of tests, unit tests (written in bun test suite) and bats tests (which are deployment tests). the bats tests will be responsible for spinning up entire nodes using docker and testing that they can communicate with eachother and so on.
- the docs/ directory contains documentation about technical implementation of the project. we should be adding to it and maintaining it as needed as development progresses.
- ensure that whenever you add a feature from the plan you always write at least basic tests for it so you can make sure we never break anything as we progress.
- ensure that we use public libp2p bootstrap nodes as a fallback (like the ones ipfs uses with a specific messaging pattern) so nodes can always find eachother.
- remember that bun doesn't need dotenv do be included it autoamtically has it included in it's suite. bun never needs to compile typescript either.
- remember we should probably create the environment early on (the docker env) so that we can spawn up our entire stack before we start developing primitives.
- when referring to bolt in files like the one pasted below, do it all in lowercase.
- never use emojis
- we have a utility for serializing bigints in the src/utils folder.
- always run `bun test` with `--bail` or using a timeout so you don't get a process that keeps running forever
- whenever you have the chance use tools native to bun vs the ones provided in node because they offer far better performance!
- when writing documentation and comments always use the tonality.md to ensure it is in-line with our project's tonality guidelines.
