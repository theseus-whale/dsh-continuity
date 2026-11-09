# -*- coding: utf-8 -*-
import time
from transformers import AutoTokenizer, AutoModelForTokenClassification, pipeline
from datasets import load_dataset
print('start', flush=True)
t0=time.time()
tok=AutoTokenizer.from_pretrained('uer/roberta-base-finetuned-cluener2020-chinese')
print('tok',time.time()-t0,flush=True)
model=AutoModelForTokenClassification.from_pretrained('uer/roberta-base-finetuned-cluener2020-chinese')
print('model',time.time()-t0,flush=True)
ner=pipeline('ner',model=model,tokenizer=tok,aggregation_strategy='simple',device=-1)
print('pipe',time.time()-t0,flush=True)
ds=load_dataset('xusenlin/clue-ner',split='validation')
print('data',time.time()-t0,flush=True)
text=ds[0]['text'][:100]
print('text',text,flush=True)
print(ner(text),flush=True)
print('done',time.time()-t0,flush=True)
