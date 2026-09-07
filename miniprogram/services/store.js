const { scooters } = require("../data/mock");

function getScooters() { return scooters; }
function getScooter(id) { return scooters.find(item => item.id === id); }
module.exports = { getScooters, getScooter };
