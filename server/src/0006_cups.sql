-- Kaunta migration #6
--  drinks.cups — JSON array of custom cup sizes {label, ml, price}
--     Enables keg-style drinks: 1L mug, 300ml cup, 250ml cup — each with own price.

ALTER TABLE drinks ADD COLUMN cups TEXT NOT NULL DEFAULT '[]';
