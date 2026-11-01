#!/bin/bash
# usage: ./q.sh 'js body' | ./q.sh -e (drain events) | ./q.sh -f file.js | echo 'js' | ./q.sh -   (use -f/- for non-ASCII text)
if [ "$1" = "-e" ]; then curl -s 127.0.0.1:3001/events
elif [ "$1" = "-f" ]; then curl -s -X POST --data-binary @"$2" 127.0.0.1:3001/eval
elif [ "$1" = "-" ]; then curl -s -X POST --data-binary @- 127.0.0.1:3001/eval
else curl -s -X POST --data-binary "$1" 127.0.0.1:3001/eval; fi; echo
