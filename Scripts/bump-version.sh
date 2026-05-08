#!/bin/bash

# Bump Version Script for Dovetail Core Package
# Usage: ./bump-version.sh [options]
# Options:
#   --commit    Also create a git commit with the version bump
#   --push      Also push the commit (requires --commit)
#   --tag       Create a git tag for the new version (requires --commit)

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Default options
COMMIT=false
PUSH=false
TAG=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --commit)
      COMMIT=true
      shift
      ;;
    --push)
      PUSH=true
      COMMIT=true  # Push requires commit
      shift
      ;;
    --tag)
      TAG=true
      COMMIT=true  # Tag requires commit
      shift
      ;;
    *)
      ;;
  esac
done

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Run the version bump
echo -e "${YELLOW}Bumping version...${NC}"
OUTPUT=$(node "$SCRIPT_DIR/bump-version.js" 2>&1)
RESULT=$?

if [ $RESULT -ne 0 ]; then
  echo -e "${RED}Failed to bump version:${NC}"
  echo "$OUTPUT"
  exit 1
fi

echo "$OUTPUT"

# Extract the new version from output
NEW_VERSION=$(echo "$OUTPUT" | grep -oP '(?<=to )\d+\.\d+\.\d+')

if [ -z "$NEW_VERSION" ]; then
  echo -e "${RED}Could not extract new version from output${NC}"
  exit 1
fi

# Git operations if requested
if [ "$COMMIT" = true ]; then
  echo -e "${YELLOW}Creating git commit...${NC}"
  
  # Stage the package.json changes
  git add "$SCRIPT_DIR/package.json"
  
  # Also check for package.json in scope directories if they exist
  if [ -f "$SCRIPT_DIR/../../dove.config.js" ]; then
    # Look for any modified package.json files in scope directories
    git add "**/package.json" 2>/dev/null
  fi
  
  # Create commit
  git commit -m "chore: bump version to $NEW_VERSION" -m "Automated version bump"
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Commit created${NC}"
    
    # Create tag if requested
    if [ "$TAG" = true ]; then
      echo -e "${YELLOW}Creating git tag v$NEW_VERSION...${NC}"
      git tag -a "v$NEW_VERSION" -m "Version $NEW_VERSION"
      
      if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Tag v$NEW_VERSION created${NC}"
      else
        echo -e "${RED}Failed to create tag${NC}"
      fi
    fi
    
    # Push if requested
    if [ "$PUSH" = true ]; then
      echo -e "${YELLOW}Pushing to remote...${NC}"
      
      # Push commits
      git push
      
      # Push tags if we created them
      if [ "$TAG" = true ]; then
        git push --tags
      fi
      
      if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Pushed to remote${NC}"
      else
        echo -e "${RED}Failed to push to remote${NC}"
        exit 1
      fi
    fi
  else
    echo -e "${RED}Failed to create commit${NC}"
    exit 1
  fi
fi

echo -e "${GREEN}✓ Version bump complete!${NC}"
echo -e "  New version: ${GREEN}$NEW_VERSION${NC}"