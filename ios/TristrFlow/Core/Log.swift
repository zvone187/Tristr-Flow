import os

/// Read with: xcrun simctl spawn booted log stream --predicate 'subsystem == "ai.pazi.tristrflow"'
let log = Logger(subsystem: "ai.pazi.tristrflow", category: "reader")
