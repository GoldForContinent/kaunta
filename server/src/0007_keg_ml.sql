-- Kaunta migration #7
--  Keg-style drinks (custom cups) are one barrel measured in ml, not bottles.
--    drinks.keg = 1 -> stockMl / open / restock qty / stock-take counts are all ml.
--    Expected money comes from cup price-per-ml rates, not full/half/quarter prices.
--  Existing cup drinks are converted once: their baseline becomes ml on hand, and
--  their old bottle-unit restock history is converted to ml so stock-takes stay sane.

ALTER TABLE drinks ADD COLUMN keg INTEGER NOT NULL DEFAULT 0;

UPDATE drinks
   SET keg = 1,
       stockMl = CASE WHEN stockMl > 0 THEN stockMl ELSE open * size END,
       open    = CAST(CASE WHEN stockMl > 0 THEN stockMl ELSE open * size END AS INTEGER)
 WHERE cups IS NOT NULL AND cups != '' AND cups != '[]';

-- Restocks recorded before this migration were bottle counts for these drinks.
UPDATE restocks
   SET qty = ROUND(qty * (SELECT d.size FROM drinks d
                           WHERE d.bar_id = restocks.bar_id AND d.id = restocks.drink))
 WHERE EXISTS (SELECT 1 FROM drinks d
                WHERE d.bar_id = restocks.bar_id
                  AND d.id = restocks.drink
                  AND d.keg = 1);
