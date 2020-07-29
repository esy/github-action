#!/bin/sh

yarn package
git add -A
git commit -m "$1"
git tag -a -f -m "$2" v1
git push origin HEAD --follow-tags -f
