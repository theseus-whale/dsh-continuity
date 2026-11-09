# -*- coding: utf-8 -*-
import os, json
from datasets import load_dataset
from transformers import BertTokenizer, AutoModelForTokenClassification, pipeline
p=os.path.join(os.environ['TEMP'],'ckip-tiny')
tok=BertTokenizer(vocab_file=os.path.join(p,'vocab.txt'))
model=AutoModelForTokenClassification.from_pretrained(p)
ner=pipeline('ner',model=model,tokenizer=tok,aggregation_strategy=None,device=-1)
ds=load_dataset('nlhappy/CLUE-NER',split='validation')
for i in range(2):
    item=ds[i]
    print('TEXT',item['text'][:120],flush=True)
    print('TOKENS',tok.tokenize(item['text'][:30]),flush=True)
    out=ner(item['text'][:120])
    print('OUT',out[:5],flush=True)
    print('GOLD',item['ents'][:5],flush=True)
