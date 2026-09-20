const physToBcm = {
  3: 2, 5: 3, 7: 4, 8: 14, 10: 15, 11: 17, 12: 18, 13: 27, 15: 22, 16: 23,
  18: 24, 19: 10, 21: 9, 22: 25, 23: 11, 24: 8, 26: 7, 29: 5, 31: 6, 32: 12,
  33: 13, 35: 19, 36: 16, 37: 26, 38: 20, 40: 21
};
function toBcm(physOrBcm) {
  const n = Number(physOrBcm);
  if (Number.isNaN(n)) throw new Error("pin not a number");
  return physToBcm[n] ?? n;
}
module.exports = { toBcm, physToBcm };
