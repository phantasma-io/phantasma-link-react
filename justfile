[private]
just:
    just -l

install:
    npm install

build:
    rm -rf ./dist
    npm run build

shad CMD:
    npx shadcn@latest {{ CMD }}

[group('publish')]
publish: build
    npm publish
