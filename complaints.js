/**
 * complaints.js — Gestion et persistance des réclamations
 *
 * Stockage en mémoire (suffisant pour un prototype).
 * Pour la production, remplacez par une base de données (PostgreSQL, MongoDB…).
 */

'use strict';

/** @type {Array<{id: string, ts: number, data: object}>} */
const complaints = [];

/**
 * Enregistre une nouvelle réclamation.
 * @param {object} data  - { type, name, rib, contact, desc, language, ticketId }
 * @returns {object}     - La réclamation sauvegardée
 */
function save(data) {
    const entry = {
        id: data.ticketId || generateId(),
        ts: Date.now(),
        data
    };
    complaints.push(entry);
    console.log(`[Complaint] Enregistré: ${entry.id}`);
    return entry;
}

/**
 * Retourne toutes les réclamations.
 */
function getAll() {
    return complaints;
}

/**
 * Retourne une réclamation par son ID.
 */
function getById(id) {
    return complaints.find(c => c.id === id) || null;
}

function generateId() {
    return 'TCK-' + Math.floor(10000 + Math.random() * 90000);
}

module.exports = { save, getAll, getById };
