'use strict';
// The `nice -n` increment that cannot be masked. nice ADDS to the niceness the caller already runs at, so a fixed
// increment lands on 0 when the host runs at its negative (nice -n 7 under a host at -7), and an answer of 0 is the
// one a constant-0 stub gives by luck. Pick the preferred increment unless that sum is 0, else the next one up; the
// result is clamped to 19 by the kernel, which is still not 0. hostNice is this process's own (os.getPriority(0),
// host node's real answer), which every child it spawns inherits.
function unmaskedIncrement(preferred, hostNice) {
  return Math.min(hostNice + preferred, 19) === 0 ? preferred + 1 : preferred;
}
module.exports = { unmaskedIncrement };
