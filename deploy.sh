#!/bin/sh

yarn package
git add -A
git commit -m "$1"
git push origin HEAD
git tag -a -m -f "$2"
git push --tags --force
